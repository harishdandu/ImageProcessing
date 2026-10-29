import { useCallback, useRef, useState } from 'react';
import { ArrowDownToLine, Award, Check, CheckCircle2, Copy, FileImage, IdCard, ImagePlus, LockKeyhole, RefreshCw, ShieldCheck, Sparkles, Upload, UserRound, X } from 'lucide-react';
import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';
import { ageFromDateOfBirth } from './lib/aadhaar-fields.js';
import {
  compressImage,
  cropEmptyMargins,
  cropPortrait,
  getPdfPageCount,
  inspectCertificate,
  isHeicFile,
  isPdfFile,
  loadImage,
  prepareCertificateFile,
  readAadhaar,
} from './lib/document-processing.js';

const PASSPORT_TARGET_BYTES = 99_999;
const CERTIFICATE_TARGET_BYTES = 199_999;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const PASSPORT_PRESETS = {
  '35x45': { label: '35 × 45 mm · 413 × 531 px', width: 413, height: 531 },
  '2x2': { label: '2 × 2 in · 600 × 600 px', width: 600, height: 600 },
  custom: { label: 'Custom dimensions', width: 413, height: 531 },
};
let faceDetectorPromise;

async function inspectPortrait(file) {
  const { image, url } = await loadImage(file);
  try {
    if (!faceDetectorPromise) {
      faceDetectorPromise = (async () => {
        const vision = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
        return FaceDetector.createFromOptions(vision, {
          baseOptions: { modelAssetPath: '/models/blaze_face_full_range.tflite' },
          runningMode: 'IMAGE',
          minDetectionConfidence: 0.65,
          minSuppressionThreshold: 0.3,
        });
      })();
    }
    const detector = await faceDetectorPromise;
    const faces = (detector.detect(image).detections || []).filter((detection) =>
      detection.categories?.some((category) => category.score >= 0.65),
    );
    if (!faces.length) return { ok: false, message: 'We couldn’t find a clear face. Upload a photo showing one person.' };
    if (faces.length > 1) return { ok: false, message: 'This looks like a group photo. Upload a portrait with just one person.' };

    const face = faces[0].boundingBox;
    const imageWidth = image.naturalWidth;
    const imageHeight = image.naturalHeight;
    const faceCenterX = (face.originX + face.width / 2) / imageWidth;
    const faceCenterY = (face.originY + face.height / 2) / imageHeight;
    if (face.width / imageWidth < 0.12 || face.height / imageHeight < 0.16) {
      return { ok: false, message: 'This looks like an ID card or a full-scene photo. Upload the portrait photo itself.' };
    }
    if (faceCenterX < 0.3 || faceCenterX > 0.7 || faceCenterY < 0.22 || faceCenterY > 0.78) {
      return { ok: false, message: 'Keep one person’s face near the center of the image, then try again.' };
    }
    return { ok: true, width: imageWidth, height: imageHeight, face };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function releasePreview(current) {
  const urls = current?.previewUrls || (current?.previewUrl ? [current.previewUrl] : []);
  urls.forEach((url) => URL.revokeObjectURL(url));
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

function getFileStem(name, fallback) {
  return name.replace(/\.[^.]+$/, '') || fallback;
}

const CERTIFICATE_FIELDS = [
  ['applicantName', 'Applicant name'],
  ['parentName', 'Father / mother name'],
  ['university', 'University'],
  ['college', 'College'],
  ['degree', 'Degree'],
  ['yearOfPassing', 'Year of passing'],
  ['registrationNumber', 'Registration / roll number'],
  ['certificateNumber', 'Certificate number'],
];

const AADHAAR_FIELDS = [
  ['name', 'Name'],
  ['dateOfBirth', 'Date of birth'],
  ['age', 'Age'],
  ['gender', 'Gender'],
  ['careOf', 'Care of (S/O, D/O, W/O)'],
  ['house', 'House / door no.'],
  ['street', 'Street name'],
  ['landmark', 'Landmark'],
  ['locality', 'Locality'],
  ['village', 'Village'],
  ['mandal', 'Mandal'],
  ['postOffice', 'Post office'],
  ['district', 'District'],
  ['state', 'State'],
  ['pincode', 'PIN code'],
  ['aadhaarNumber', 'Aadhaar number'],
  ['fullAddress', 'Full address'],
];

const AADHAAR_SIDE_LABEL = {
  full: 'Full card',
  front: 'Front',
  back: 'Back',
  partial: 'Partial card',
};

export default function App() {
  const inputRef = useRef(null);
  const [tool, setTool] = useState('passport');
  const [passportPreset, setPassportPreset] = useState('35x45');
  const [customWidth, setCustomWidth] = useState('413');
  const [customHeight, setCustomHeight] = useState('531');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [processingStep, setProcessingStep] = useState('');
  const [error, setError] = useState('');
  const [photo, setPhoto] = useState(null);
  const [pendingPdf, setPendingPdf] = useState(null);
  const [selectedPdfPage, setSelectedPdfPage] = useState(1);

  const preset = PASSPORT_PRESETS[passportPreset];
  const outputWidth = passportPreset === 'custom' ? Number(customWidth) || 413 : preset.width;
  const outputHeight = passportPreset === 'custom' ? Number(customHeight) || 531 : preset.height;

  const resetResult = () => {
    setError('');
    setPendingPdf(null);
    setPhoto((current) => {
      releasePreview(current);
      return null;
    });
    if (inputRef.current) inputRef.current.value = '';
  };

  const processFile = useCallback(async (file, pdfPageNumber) => {
    if (!file) return;
    setError('');
    const isImage = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)
      || /\.(jpe?g|png|webp)$/i.test(file.name);
    const isPdf = (tool === 'certificate' || tool === 'aadhaar') && isPdfFile(file);
    const isHeic = isHeicFile(file);
    const supported = tool === 'passport'
      ? isImage || isHeic
      : isPdf || isHeic || ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name);
    if (!supported) {
      setError(tool === 'passport'
        ? 'Choose a JPG, JPEG, PNG, WebP, or HEIC portrait.'
        : tool === 'aadhaar'
          ? 'Choose a PDF, JPG, JPEG, PNG, WebP, or HEIC photo of the Aadhaar card.'
          : 'Choose a PDF, JPG, JPEG, PNG, WebP, or HEIC certificate or marksheet.');
      return;
    }
    if (tool === 'passport' && (outputWidth < 100 || outputHeight < 100 || outputWidth > 3000 || outputHeight > 3000)) {
      setError('Enter photo dimensions between 100 and 3000 pixels.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError('This file is over 25 MB. Choose a smaller original.');
      return;
    }

    if (tool === 'certificate' && isPdf && pdfPageNumber === undefined) {
      setBusy(true);
      setProcessingStep('Reading PDF pages…');
      try {
        const pageCount = await getPdfPageCount(file);
        setPendingPdf({ file, pageCount });
        setSelectedPdfPage(1);
      } catch {
        setError('We couldn’t read that PDF. Try a valid, unprotected PDF file.');
      } finally {
        setBusy(false);
        setProcessingStep('');
      }
      return;
    }

    setPendingPdf(null);
    setBusy(true);
    setProcessingStep(tool === 'passport' ? 'Preparing photo…' : tool === 'aadhaar' ? 'Preparing Aadhaar…' : 'Preparing certificate…');
    setPhoto((current) => {
      releasePreview(current);
      return null;
    });
    try {
      if (tool === 'aadhaar') {
        const result = await readAadhaar(file, setProcessingStep);
        if (!result.ok) throw new Error(result.message);
        const previewUrls = (result.files || [result.file]).map((page) => URL.createObjectURL(page));
        setPhoto({
          blob: result.file,
          width: result.width,
          height: result.height,
          outputType: result.file.type || 'image/jpeg',
          tool: 'aadhaar',
          side: result.side,
          fields: result.fields,
          pagesRead: result.pagesRead,
          pageCount: result.pageCount,
          originalName: file.name,
          originalSize: file.size,
          marginsCropped: result.marginsCropped,
          uncroppedWidth: result.sourceWidth,
          uncroppedHeight: result.sourceHeight,
          contentWidth: result.contentWidth,
          contentHeight: result.contentHeight,
          previewUrl: previewUrls[0],
          previewUrls,
        });
        return;
      }

      const preparedImage = tool === 'certificate'
        ? await prepareCertificateFile(file, pdfPageNumber || 1)
        : isHeic ? await prepareCertificateFile(file) : file;
      setProcessingStep('Removing empty margins…');
      const trimmed = await cropEmptyMargins(preparedImage, tool);
      const inputImage = trimmed.file;

      let inspection;
      if (tool === 'passport') {
        setProcessingStep('Checking for a person…');
        try {
          inspection = await inspectPortrait(inputImage);
        } catch {
          throw new Error('The face check could not run. Please reload the page and try again.');
        }
        if (!inspection.ok) throw new Error(inspection.message);
      } else {
        setProcessingStep('Reading certificate text…');
        try {
          inspection = await inspectCertificate(inputImage);
        } catch {
          throw new Error('Certificate text recognition could not start. Check your connection and try again.');
        }
        if (!inspection.ok) throw new Error(inspection.message);
      }

      const targetBytes = tool === 'passport' ? PASSPORT_TARGET_BYTES : CERTIFICATE_TARGET_BYTES;
      let result;
      let alreadyUnderLimit = false;
      if (tool === 'passport') {
        setProcessingStep('Cropping and resizing portrait…');
        const cropped = await cropPortrait(inputImage, inspection.face, outputWidth, outputHeight);
        setProcessingStep('Compressing passport photo…');
        result = await compressImage(cropped, targetBytes, { allowDownscale: false });
      } else {
        alreadyUnderLimit = !trimmed.cropped && inputImage.type === 'image/jpeg' && inputImage.size < targetBytes;
        if (alreadyUnderLimit) {
          result = {
            blob: inputImage,
            width: inspection.width,
            height: inspection.height,
            sourceWidth: inspection.width,
            sourceHeight: inspection.height,
            downscaled: false,
            reachedTarget: true,
          };
        } else {
          setProcessingStep('Compressing certificate…');
          result = await compressImage(inputImage, targetBytes);
        }
      }

      const previewUrl = URL.createObjectURL(result.blob);
      setPhoto({
        ...result,
        outputType: 'image/jpeg',
        alreadyUnderLimit,
        targetBytes,
        tool,
        fields: inspection.fields || {},
        originalName: file.name,
        originalSize: file.size,
        originalWidth: inspection.width,
        originalHeight: inspection.height,
        marginsCropped: trimmed.cropped,
        uncroppedWidth: trimmed.sourceWidth,
        uncroppedHeight: trimmed.sourceHeight,
        contentWidth: trimmed.width || inspection.width,
        contentHeight: trimmed.height || inspection.height,
        previewUrl,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong while processing this file.');
    } finally {
      setBusy(false);
      setProcessingStep('');
      if (inputRef.current) inputRef.current.value = '';
    }
  }, [tool, outputWidth, outputHeight]);

  const download = () => {
    if (!photo) return;
    const link = document.createElement('a');
    link.href = photo.previewUrl;
    const fallback = photo.tool === 'passport' ? 'passport-photo' : photo.tool === 'aadhaar' ? 'aadhaar-card' : 'degree-certificate';
    link.download = `${getFileStem(photo.originalName, fallback)}-processed.jpg`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const selectTool = (nextTool) => {
    setTool(nextTool);
    setError('');
    setPendingPdf(null);
    setPhoto((current) => {
      releasePreview(current);
      return null;
    });
  };

  const isPassport = tool === 'passport';
  const isAadhaar = tool === 'aadhaar';
  const accept = isPassport
    ? '.jpg,.jpeg,.png,.webp,.heic,.heif,image/jpeg,image/png,image/webp,image/heic,image/heif'
    : '.pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif';
  const uploadTitle = isPassport ? 'Drop your portrait photo here' : isAadhaar ? 'Drop the Aadhaar card here' : 'Drop your certificate or marksheet here';
  const uploadHint = isPassport ? 'JPG, JPEG, PNG, WebP, or HEIC · one clear face' : isAadhaar ? 'Full card, front, or back · PDF, JPG, PNG, WebP, or HEIC' : 'PDF, JPG, JPEG, PNG, WebP, or HEIC · up to 25 MB';

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Under100 home">
          <span className="brand-mark"><ImagePlus size={19} strokeWidth={2.2} /></span>
          <span>{isAadhaar ? 'Aadhaar' : 'under'}<span className="brand-light">{isAadhaar ? '' : isPassport ? '100' : '200'}</span></span>
        </a>
        <div className="topbar-note"><LockKeyhole size={14} /> Your files stay on your device</div>
      </header>

      <main id="top" className={photo?.tool === 'aadhaar' ? 'main-content main-content-wide' : 'main-content'}>
        <section className="intro">
          <div className="eyebrow"><span className="eyebrow-dot" /> {isPassport ? 'PASSPORT PHOTO TOOL' : isAadhaar ? 'AADHAAR DETAILS' : 'DEGREE CERTIFICATE TOOL'}</div>
          <h1>{isPassport ? <>Passport photo.<br /><span>Under 100 KB.</span></> : isAadhaar ? <>Aadhaar card.<br /><span>Read the details.</span></> : <>Degree certificate.<br /><span>Under 200 KB.</span></>}</h1>
          <p className="intro-copy">{isPassport
            ? 'Crop away empty space, frame the portrait, and export at your selected dimensions.'
            : isAadhaar
              ? 'Upload a full Aadhaar, or only the front or the back. Name, age, gender, street, village, mandal, PIN, and the other printed details are read in your browser.'
              : 'Crop away empty space, validate a degree certificate or marksheet, and prepare a JPG under 200 KB.'}</p>
          <div className="promise-row">
            <span><Check size={15} /> Original stays private</span>
            <span><Check size={15} /> JPG output</span>
            <span><Check size={15} /> Free to use</span>
          </div>
        </section>

        <div className="tool-switch" role="tablist" aria-label="Choose what to process">
          <button type="button" role="tab" aria-selected={tool === 'passport'} className={tool === 'passport' ? 'tool-tab active' : 'tool-tab'} disabled={busy} onClick={() => selectTool('passport')}>
            <UserRound size={16} /> <span>Passport photo</span> <small>100 KB</small>
          </button>
          <button type="button" role="tab" aria-selected={tool === 'certificate'} className={tool === 'certificate' ? 'tool-tab active' : 'tool-tab'} disabled={busy} onClick={() => selectTool('certificate')}>
            <Award size={16} /> <span>Certificate / marksheet</span> <small>200 KB</small>
          </button>
          <button type="button" role="tab" aria-selected={isAadhaar} className={isAadhaar ? 'tool-tab active' : 'tool-tab'} disabled={busy} onClick={() => selectTool('aadhaar')}>
            <IdCard size={16} /> <span>Aadhaar card</span> <small>Details</small>
          </button>
        </div>

        {tool === 'passport' && !photo && (
          <div className="dimension-control">
            <label htmlFor="photo-preset">Required photo size</label>
            <select id="photo-preset" value={passportPreset} onChange={(event) => setPassportPreset(event.target.value)}>
              {Object.entries(PASSPORT_PRESETS).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}
            </select>
            {passportPreset === 'custom' && <div className="custom-dimensions"><label>Width <input type="number" min="100" max="3000" value={customWidth} onChange={(event) => setCustomWidth(event.target.value)} /> px</label><label>Height <input type="number" min="100" max="3000" value={customHeight} onChange={(event) => setCustomHeight(event.target.value)} /> px</label></div>}
          </div>
        )}

        <section className="workspace" aria-label={isPassport ? 'Passport photo processor' : isAadhaar ? 'Aadhaar reader' : 'Certificate processor'}>
          {photo ? (
            <div className="result-card">
              <div className="result-heading"><div><div className="success-kicker"><CheckCircle2 size={15} /> {photo.tool === 'passport' ? 'PHOTO READY' : photo.tool === 'aadhaar' ? 'DETAILS READY' : 'CERTIFICATE READY'}</div><h2>{photo.tool === 'passport' ? 'Passport photo preview' : photo.tool === 'aadhaar' ? 'Aadhaar details' : 'Certificate preview'}</h2></div><button type="button" className="icon-button" onClick={resetResult} aria-label="Start over"><RefreshCw size={17} /></button></div>
              {photo.tool === 'aadhaar' ? (
                <div className="aadhaar-layout">
                  <div className="aadhaar-preview">
                    {(photo.previewUrls || [photo.previewUrl]).map((url, index, urls) => (
                      <figure key={url}>
                        <img src={url} alt={urls.length > 1 ? `Uploaded Aadhaar page ${index + 1}` : 'Uploaded Aadhaar card'} />
                        {urls.length > 1 && <figcaption>Page {index + 1}</figcaption>}
                      </figure>
                    ))}
                  </div>
                  <div className="aadhaar-details">
                    <div className="size-block">
                      <div className="size-label">CARD READ</div>
                      <div className="new-size">{AADHAAR_SIDE_LABEL[photo.side] || 'Card'} <span>/ {AADHAAR_FIELDS.filter(([key]) => photo.fields[key]?.trim()).length} fields</span></div>
                      <p className="saved-note"><CheckCircle2 size={14} /> English text was read on this device. Correct anything that looks wrong.</p>
                    </div>
                    {photo.side === 'front' && <div className="notice" role="status"><ShieldCheck size={17} /><p>Street, village, mandal, and PIN are usually printed on the back. Upload the back if those fields are empty.</p></div>}
                    {photo.side === 'back' && <div className="notice" role="status"><ShieldCheck size={17} /><p>Name, age, and gender are usually printed on the front. Upload the front if those fields are empty.</p></div>}
                    {photo.fields.ageBasis === 'year' && <div className="notice" role="status"><ShieldCheck size={17} /><p>Age is counted from the year of birth only, because the card does not show a full date.</p></div>}
                    <ExtractedFields label="Extracted Aadhaar details" description="Review and correct the text recognized from the card." definitions={AADHAAR_FIELDS} fields={photo.fields} wideKeys={['fullAddress']} allowCopyAll onChange={(key, value) => setPhoto((current) => { const fields = { ...current.fields, [key]: value }; if (key === 'dateOfBirth') { fields.age = value.trim() ? ageFromDateOfBirth(value) : ''; fields.ageBasis = /\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4}/.test(value) ? 'date' : (fields.age ? 'year' : ''); } return { ...current, fields }; })} />
                    <div className="aadhaar-actions">
                      <button className="download-button" type="button" onClick={download}><ArrowDownToLine size={17} /> Download image</button>
                      <button className="start-over" type="button" onClick={resetResult}>Process another document</button>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="result-body">
                    <div className="photo-preview"><img src={photo.previewUrl} alt={photo.tool === 'passport' ? 'Processed passport photo preview' : 'Processed certificate page preview'} /></div>
                    <div className="result-details">
                      <div className="size-block"><div className="size-label">FINAL FILE SIZE</div><div className="new-size">{formatBytes(photo.blob.size)} <span> / {Math.round(photo.targetBytes / 1000)} KB</span></div><div className="progress-track"><div className="progress-value" style={{ width: `${Math.min(100, photo.blob.size / photo.targetBytes * 100)}%` }} /></div><p className="saved-note">{photo.alreadyUnderLimit ? <><CheckCircle2 size={14} /> Already valid — original JPG kept</> : photo.reachedTarget ? <><CheckCircle2 size={14} /> File size checked and under limit</> : <>Could not reach the file-size limit.</>}</p></div>
                      <div className="file-stats"><div><span>Final dimensions</span><strong>{photo.width} × {photo.height} px</strong></div><div><span>Original size</span><strong>{formatBytes(photo.originalSize)}</strong></div><div><span>Output format</span><strong>JPG / JPEG</strong></div></div>
                      <button className="download-button" type="button" onClick={download}><ArrowDownToLine size={17} /> Download JPG</button>
                      <button className="start-over" type="button" onClick={resetResult}>Process another {photo.tool === 'passport' ? 'photo' : 'document'}</button>
                    </div>
                  </div>
                  {photo.marginsCropped && <div className="notice" role="status"><ShieldCheck size={17} /><p>Empty space was cropped off before resizing, from {photo.uncroppedWidth} × {photo.uncroppedHeight} px to {photo.contentWidth} × {photo.contentHeight} px.</p></div>}
                  {photo.downscaled && <div className="notice" role="status"><ShieldCheck size={17} /><p>To meet the file-size limit, dimensions were reduced from {photo.sourceWidth} × {photo.sourceHeight} px to {photo.width} × {photo.height} px.</p></div>}
                  {photo.tool === 'certificate' && <ExtractedFields label="Extracted certificate details" description="Review and correct the text recognized from the document." definitions={CERTIFICATE_FIELDS} fields={photo.fields} onChange={(key, value) => setPhoto((current) => ({ ...current, fields: { ...current.fields, [key]: value } }))} />}
                </>
              )}
            </div>
          ) : pendingPdf ? (
            <div className="pdf-page-card">
              <div className="success-kicker"><FileImage size={15} /> PDF READY</div>
              <h2>Select the page to process</h2>
              <p>This PDF has {pendingPdf.pageCount} pages. Choose which certificate or marksheet page to extract.</p>
              <label htmlFor="pdf-page">PDF page</label>
              <select id="pdf-page" value={selectedPdfPage} onChange={(event) => setSelectedPdfPage(Number(event.target.value))}>
                {Array.from({ length: pendingPdf.pageCount }, (_, index) => <option key={index + 1} value={index + 1}>Page {index + 1}</option>)}
              </select>
              <button className="choose-button" type="button" disabled={busy} onClick={() => processFile(pendingPdf.file, selectedPdfPage)}>{busy ? <><span className="spinner" /> {processingStep}</> : 'Validate and process page'}</button>
              <button className="start-over" type="button" onClick={() => setPendingPdf(null)}>Choose a different file</button>
            </div>
          ) : (
            <div className={`upload-card ${dragging ? 'is-dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); processFile(event.dataTransfer.files?.[0]); }}>
              <input ref={inputRef} className="visually-hidden" type="file" accept={accept} aria-label={isPassport ? 'Choose a passport photo' : isAadhaar ? 'Choose an Aadhaar card' : 'Choose a certificate or marksheet'} onChange={(event) => processFile(event.target.files?.[0])} />
              <div className="upload-illustration"><div className="upload-photo-icon"><FileImage size={26} strokeWidth={1.7} /></div><span className="sparkle sparkle-one"><Sparkles size={13} /></span><span className="sparkle sparkle-two" /></div>
              <h2>{busy ? processingStep : uploadTitle}</h2>
              <p className="upload-subtitle">or choose a file from your device</p>
              <button className="choose-button" type="button" disabled={busy} onClick={() => inputRef.current?.click()}>
                {busy ? <><span className="spinner" /> {processingStep}</> : <><Upload size={16} /> Choose {isPassport ? 'a photo' : isAadhaar ? 'an Aadhaar card' : 'a document'}</>}
              </button>
              <p className="file-hint">{uploadHint}</p>
              {error && <div className="error-message" role="alert"><X size={15} />{error}</div>}
            </div>
          )}
        </section>

        <div className="privacy-note"><ShieldCheck size={16} /><span><strong>Private by design.</strong> Your photo and document stay in your browser and are never uploaded. Text recognition loads its engine and English data the first time it is used.</span></div>
        <section className="how-it-works">
          <div className="section-heading"><span>THE SIMPLE WAY</span><h2>{isPassport ? 'A passport-ready portrait' : 'Details ready to review'}</h2></div>
          <div className="steps-grid"><article className="step"><div className="step-number">01</div><div><h3>{isPassport ? 'Crop and frame' : isAadhaar ? 'Upload any side' : 'Crop and validate'}</h3><p>{isPassport ? 'Remove blank space around the photo, then frame the face.' : isAadhaar ? 'Use a full Aadhaar, or a photo of only the front or the back.' : 'Remove blank space around the page, then read the certificate locally.'}</p></div></article><article className="step"><div className="step-number">02</div><div><h3>{isPassport ? 'Resize and compress' : 'Extract key details'}</h3><p>{isPassport ? 'Export at the required pixel size as JPG under 100 KB.' : isAadhaar ? 'Name, age, gender, street, village, mandal, and PIN are filled from the card.' : 'Review and correct OCR fields before using the compressed JPG.'}</p></div></article><article className="step"><div className="step-number">03</div><div><h3>{isAadhaar ? 'Review and copy' : 'Preview and download'}</h3><p>{isAadhaar ? 'Correct any field, then copy the details you need.' : 'Check the final image and its file size before saving.'}</p></div></article></div>
        </section>
      </main>
      <footer className="footer"><span>{isAadhaar ? 'Aadhaar' : `under${isPassport ? '100' : '200'}`}</span><span>Made for easier applications.</span></footer>
    </div>
  );
}

function ExtractedFields({ label, description, definitions, fields, onChange, wideKeys = [], allowCopyAll = false }) {
  const [copiedField, setCopiedField] = useState('');

  const copyText = async (key, value) => {
    if (!value?.trim()) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(key);
      window.setTimeout(() => setCopiedField((current) => current === key ? '' : current), 1600);
    } catch {
      setCopiedField('');
    }
  };

  const copyAll = () => {
    const text = definitions
      .map(([key, fieldLabel]) => [fieldLabel, fields[key]?.trim()])
      .filter(([, value]) => value)
      .map(([fieldLabel, value]) => `${fieldLabel}: ${value}`)
      .join('\n');
    copyText('all', text);
  };

  return (
    <section className="extracted-panel" aria-label={label}>
      <div className="extracted-heading"><div><h3>Extracted details</h3><p>{description}</p></div>{allowCopyAll ? <button className="copy-all-button" type="button" onClick={copyAll}>{copiedField === 'all' ? 'Copied' : 'Copy all'}</button> : <span>Editable</span>}</div>
      <div className="extracted-grid">
        {definitions.map(([key, fieldLabel]) => <label key={key} className={wideKeys.includes(key) ? 'extracted-field wide' : 'extracted-field'}>{fieldLabel}<span className="extracted-value"><input value={fields[key] || ''} placeholder="Not found" onChange={(event) => onChange(key, event.target.value)} /><button className="copy-field-button" type="button" aria-label={`Copy ${fieldLabel}`} title={copiedField === key ? 'Copied' : `Copy ${fieldLabel}`} disabled={!fields[key]?.trim()} onClick={() => copyText(key, fields[key])}>{copiedField === key ? <Check size={14} /> : <Copy size={14} />}</button></span></label>)}
      </div>
    </section>
  );
}
