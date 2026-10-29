import { parseAadhaarText } from './aadhaar-fields.js';

let pdfjsPromise;
let ocrWorkerPromise;

async function recognizeText(source) {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = import('tesseract.js').then(({ createWorker }) => createWorker('eng', 1));
  }
  const worker = await ocrWorkerPromise;
  const { data } = await worker.recognize(source);
  return data.text || '';
}

async function getPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]).then(([pdfjsLib, workerModule]) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerModule.default;
      return pdfjsLib;
    });
  }
  return pdfjsPromise;
}

export function isPdfFile(file) {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

export function isHeicFile(file) {
  return ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'].includes(file.type)
    || /\.hei[cf]$/i.test(file.name);
}

export async function getPdfPageCount(file) {
  const pdfjsLib = await getPdfJs();
  const task = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdfDocument = await task.promise;
  const pageCount = pdfDocument.numPages;
  await pdfDocument.destroy();
  return pageCount;
}

function canvasToJpeg(canvas, quality = 0.94) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('This page could not be converted to an image.')), 'image/jpeg', quality);
  });
}

export async function prepareCertificateFile(file, pageNumber = 1) {
  if (isPdfFile(file)) {
    const pdfjsLib = await getPdfJs();
    const task = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    const pdfDocument = await task.promise;
    try {
      if (pageNumber < 1 || pageNumber > pdfDocument.numPages) {
        throw new Error('Choose a valid page from the PDF.');
      }
      const page = await pdfDocument.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 2 });
      const scale = Math.min(1, 2600 / Math.max(baseViewport.width, baseViewport.height));
      const viewport = page.getViewport({ scale: 2 * scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Your browser could not render this PDF page.');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const blob = await canvasToJpeg(canvas);
      const baseName = file.name.replace(/\.pdf$/i, '');
      return new File([blob], `${baseName}-page-${pageNumber}.jpg`, { type: 'image/jpeg' });
    } finally {
      await pdfDocument.destroy();
    }
  }

  if (isHeicFile(file)) {
    const { default: heic2any } = await import('heic2any');
    const converted = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.94 });
    const blob = Array.isArray(converted) ? converted[0] : converted;
    const baseName = file.name.replace(/\.hei[cf]$/i, '');
    return new File([blob], `${baseName || 'certificate'}.jpg`, { type: 'image/jpeg' });
  }

  return file;
}

export function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({ image, url });
    image.style.imageOrientation = 'from-image';
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('We couldn’t open that image. Try a JPG, JPEG, PNG, or HEIC file.'));
    };
    image.src = url;
  });
}

export async function inspectCertificate(file) {
  const { image, url } = await loadImage(file);
  try {
    const text = await recognizeText(image);
    const normalized = text.toLowerCase().replace(/\s+/g, ' ');
    const letters = normalized.match(/[a-z]{3,}/g) || [];
    const hasCredentialTerm = /\b(degree|certificate|diploma|bachelor|master|graduat\w*|conferred|awarded|undergraduate|postgraduate|marksheet|mark\s+sheet|transcript|statement\s+of\s+marks)\b/.test(normalized);
    const hasInstitutionTerm = /\b(university|college|institute|polytechnic|faculty|academy|school)\b/.test(normalized);
    const hasAcademicTerm = /\b(science|arts|engineering|commerce|technology|management|education|medicine|law|business)\b/.test(normalized);

    if (letters.length < 15 || !hasCredentialTerm || (!hasInstitutionTerm && !hasAcademicTerm)) {
      return {
        ok: false,
        width: image.naturalWidth,
        height: image.naturalHeight,
        message: 'We couldn’t verify this as a degree certificate or marksheet. Upload a clear page with readable English text.',
      };
    }

    return {
      ok: true,
      width: image.naturalWidth,
      height: image.naturalHeight,
      text,
      fields: extractCertificateFields(text),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function pdfItemsToLines(items) {
  const rows = [];
  items.forEach((item) => {
    if (!item.str || !String(item.str).trim() || !item.transform) return;
    const y = item.transform[5];
    const x = item.transform[4];
    let row = rows.find((entry) => Math.abs(entry.y - y) < 2);
    if (!row) {
      row = { y, parts: [] };
      rows.push(row);
    }
    row.parts.push({ x, str: item.str });
  });
  return rows
    .sort((left, right) => right.y - left.y)
    .map((row) => row.parts.sort((left, right) => left.x - right.x).map((part) => part.str).join(' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

async function openPdf(file) {
  const pdfjsLib = await getPdfJs();
  const task = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  return task.promise;
}

export async function extractPdfText(file, maxPages = 4) {
  const pdfDocument = await openPdf(file);
  try {
    const pagesRead = Math.min(pdfDocument.numPages, maxPages);
    const parts = [];
    for (let pageNumber = 1; pageNumber <= pagesRead; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const content = await page.getTextContent();
      parts.push(pdfItemsToLines(content.items));
    }
    return { text: parts.filter(Boolean).join('\n'), pageCount: pdfDocument.numPages, pagesRead };
  } finally {
    await pdfDocument.destroy();
  }
}

async function renderPdfPreviewFiles(file, maxPages) {
  const pdfDocument = await openPdf(file);
  try {
    const pagesRead = Math.min(pdfDocument.numPages, maxPages);
    const files = [];
    const baseName = file.name.replace(/\.pdf$/i, '') || 'aadhaar';
    for (let pageNumber = 1; pageNumber <= pagesRead; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 2 });
      const scale = Math.min(1, 2600 / Math.max(baseViewport.width, baseViewport.height));
      const viewport = page.getViewport({ scale: 2 * scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Your browser could not render this PDF page.');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const blob = await canvasToJpeg(canvas, 0.92);
      files.push(new File([blob], `${baseName}-page-${pageNumber}.jpg`, { type: 'image/jpeg' }));
    }
    return files;
  } finally {
    await pdfDocument.destroy();
  }
}

async function ocrPdfPages(file, maxPages) {
  const pdfDocument = await openPdf(file);
  try {
    const pagesRead = Math.min(pdfDocument.numPages, maxPages);
    const parts = [];
    for (let pageNumber = 1; pageNumber <= pagesRead; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Your browser could not render this PDF page.');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      parts.push(await recognizeText(canvas));
    }
    return parts.filter(Boolean).join('\n');
  } finally {
    await pdfDocument.destroy();
  }
}

export async function readAadhaar(file, onProgress = () => {}) {
  onProgress('Preparing Aadhaar…');
  let text = '';
  let pageCount = 1;
  let pagesRead = 1;
  let sourceFiles = [file];

  if (isPdfFile(file)) {
    const extracted = await extractPdfText(file, 4);
    pageCount = extracted.pageCount;
    pagesRead = extracted.pagesRead;
    text = extracted.text;
    if (!parseAadhaarText(text).ok) {
      onProgress('Reading Aadhaar text…');
      const ocrText = await ocrPdfPages(file, pagesRead);
      text = [text, ocrText].filter(Boolean).join('\n');
    }
    sourceFiles = await renderPdfPreviewFiles(file, pagesRead);
  } else if (isHeicFile(file)) {
    sourceFiles = [await prepareCertificateFile(file)];
  }

  onProgress('Removing empty margins…');
  const trimmedPages = [];
  for (const sourceFile of sourceFiles) trimmedPages.push(await cropEmptyMargins(sourceFile, 'certificate'));
  const trimmed = trimmedPages[0];
  const { image, url } = await loadImage(trimmed.file);
  try {
    if (!isPdfFile(file) || !parseAadhaarText(text).ok) {
      onProgress('Reading Aadhaar text…');
      const ocrText = await recognizeText(image);
      text = [text, ocrText].filter(Boolean).join('\n');
    }
    const parsed = parseAadhaarText(text);
    if (!parsed.ok) {
      return { ok: false, message: parsed.message, width: image.naturalWidth, height: image.naturalHeight };
    }
    return {
      ok: true,
      fields: parsed.fields,
      side: parsed.side,
      width: image.naturalWidth,
      height: image.naturalHeight,
      file: trimmed.file,
      files: trimmedPages.map((page) => page.file),
      marginsCropped: trimmed.cropped,
      sourceWidth: trimmed.sourceWidth,
      sourceHeight: trimmed.sourceHeight,
      contentWidth: trimmed.width || image.naturalWidth,
      contentHeight: trimmed.height || image.naturalHeight,
      pagesRead,
      pageCount,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function findLabeledValue(lines, pattern) {
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(pattern);
    if (!match) continue;
    const sameLineValue = (match[1] || '').replace(/^[\s:#–—-]+/, '').trim();
    if (sameLineValue.length > 1) return sameLineValue.slice(0, 100);
    const nextLine = lines[index + 1]?.trim();
    if (nextLine && nextLine.length > 1 && nextLine.length < 100) return nextLine;
  }
  return '';
}

function extractCertificateFields(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const name = findLabeledValue(lines, /^(?:name\s+of\s+(?:the\s+)?(?:candidate|student)|candidate\s+name|student\s+name|name)\s*[:#–—-]?\s*(.*)$/i);
  const fatherMother = findLabeledValue(lines, /^(?:father|mother|guardian)(?:'s)?\s+name\s*[:#–—-]?\s*(.*)$/i);
  const university = lines.find((line) => /\b(university|universite|university)\b/i.test(line)) || '';
  const college = lines.find((line) => /\b(college|institute|polytechnic|faculty)\b/i.test(line)) || '';
  const degree = lines.find((line) => /\b(bachelor|master|doctorate|degree|diploma|b\.? ?(a|sc|com|tech)|m\.? ?(a|sc|com|tech))\b/i.test(line)) || '';
  const yearMatch = text.match(/(?:passed|passing|graduat\w*|completed|awarded|conferred|class\s+of)\D{0,30}((?:19|20)\d{2})/i)
    || text.match(/\b((?:19|20)\d{2})\b/);
  const registration = findLabeledValue(lines, /\b(?:registration|reg\.?|roll|enrol?ment|student)\s*(?:no\.?|number|#)?\s*[:#–—-]?\s*(.*)$/i);
  const certificateNumber = findLabeledValue(lines, /\b(?:certificate|serial)\s*(?:no\.?|number|#)\s*[:#–—-]?\s*(.*)$/i);

  return {
    applicantName: name,
    parentName: fatherMother,
    university: university.slice(0, 100),
    college: college.slice(0, 100),
    degree: degree.slice(0, 100),
    yearOfPassing: yearMatch?.[1] || '',
    registrationNumber: registration,
    certificateNumber,
  };
}

const CONTENT_ANALYSIS_MAX = 720;

function colorDistanceSquared(r, g, b, background) {
  const dr = r - background.r;
  const dg = g - background.g;
  const db = b - background.b;
  return dr * dr + dg * dg + db * db;
}

function samplePatch(data, width, height, originX, originY, patchSize) {
  const lumas = [];
  const reds = [];
  const greens = [];
  const blues = [];
  const x1 = Math.min(width, originX + patchSize);
  const y1 = Math.min(height, originY + patchSize);
  for (let y = originY; y < y1; y += 1) {
    for (let x = originX; x < x1; x += 1) {
      const offset = (y * width + x) * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      reds.push(r);
      greens.push(g);
      blues.push(b);
      lumas.push((r * 54 + g * 183 + b * 19) >> 8);
    }
  }
  if (lumas.length < 16) return null;
  const median = (values) => {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const mid = median(lumas);
  const variance = lumas.reduce((sum, value) => sum + (value - mid) ** 2, 0) / lumas.length;
  return {
    r: median(reds),
    g: median(greens),
    b: median(blues),
    luma: mid,
    stddev: Math.sqrt(variance),
  };
}

function estimateBackground(data, width, height) {
  const patchSize = Math.min(
    Math.max(4, Math.round(Math.min(width, height) * 0.07)),
    Math.floor(width / 2),
    Math.floor(height / 2),
  );
  if (patchSize < 4) return null;
  const patches = [
    [0, 0],
    [width - patchSize, 0],
    [0, height - patchSize],
    [width - patchSize, height - patchSize],
  ].map(([x, y]) => samplePatch(data, width, height, x, y, patchSize)).filter((patch) => patch && patch.stddev < 16 && patch.luma >= 165);
  if (!patches.length) return null;

  let bestGroup = [];
  patches.forEach((seed) => {
    const group = patches.filter((patch) => colorDistanceSquared(patch.r, patch.g, patch.b, seed) < 18 * 18);
    if (group.length > bestGroup.length) bestGroup = group;
  });
  const confident = bestGroup.length >= 2 || (bestGroup.length === 1 && bestGroup[0].stddev < 8 && bestGroup[0].luma > 185);
  if (!confident) return null;
  const average = (key) => Math.round(bestGroup.reduce((sum, patch) => sum + patch[key], 0) / bestGroup.length);
  return { r: average('r'), g: average('g'), b: average('b') };
}

function dilateMask(mask, width, height, radius) {
  const dilated = new Uint8Array(mask);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(height - 1, y + radius);
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      for (let yy = y0; yy <= y1; yy += 1) {
        dilated.fill(1, yy * width + x0, yy * width + x1 + 1);
      }
    }
  }
  return dilated;
}

function contentBounds(mask, width, height) {
  const columnCount = new Uint32Array(width);
  const rowCount = new Uint32Array(height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      columnCount[x] += 1;
      rowCount[y] += 1;
    }
  }
  const minColumn = Math.max(4, Math.round(height * 0.012));
  const minRow = Math.max(4, Math.round(width * 0.012));
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let content = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      if (columnCount[x] < minColumn && rowCount[y] < minRow) continue;
      content += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  const boxWidth = maxX - minX + 1;
  const boxHeight = maxY - minY + 1;
  return {
    x: minX,
    y: minY,
    width: boxWidth,
    height: boxHeight,
    coverage: content / (boxWidth * boxHeight),
  };
}

function expandRect(rect, width, height, padding) {
  const x0 = Math.max(0, Math.floor(rect.x - padding.left));
  const y0 = Math.max(0, Math.floor(rect.y - padding.top));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.width + padding.right));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.height + padding.bottom));
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

function hasMargin(rect, width, height, minimumRatio) {
  const left = rect.x / width;
  const right = (width - rect.x - rect.width) / width;
  const top = rect.y / height;
  const bottom = (height - rect.y - rect.height) / height;
  return left >= minimumRatio || right >= minimumRatio || top >= minimumRatio || bottom >= minimumRatio;
}

function blurLuma(luma, width, height, radius) {
  const horizontal = new Float32Array(luma.length);
  const blurred = new Float32Array(luma.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let count = 0;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const xx = x + dx;
        if (xx < 0 || xx >= width) continue;
        sum += luma[y * width + xx];
        count += 1;
      }
      horizontal[y * width + x] = sum / count;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        sum += horizontal[yy * width + x];
        count += 1;
      }
      blurred[y * width + x] = sum / count;
    }
  }
  return blurred;
}

function fitInlierLine(points, key, height) {
  let best = null;
  let bestCount = 0;
  for (let i = 0; i < points.length; i += 3) {
    for (let j = i + 8; j < points.length; j += 3) {
      const y1 = points[i].y;
      const y2 = points[j].y;
      if (y2 - y1 < height * 0.22) continue;
      const slope = (points[j][key] - points[i][key]) / (y2 - y1);
      if (Math.abs(slope) > 0.85) continue;
      const intercept = points[i][key] - slope * y1;
      let count = 0;
      for (let index = 0; index < points.length; index += 1) {
        const point = points[index];
        if (Math.abs(point[key] - (slope * point.y + intercept)) < 8) count += 1;
      }
      if (count > bestCount) {
        bestCount = count;
        best = { slope, intercept };
      }
    }
  }
  if (!best || bestCount < height * 0.22) return null;
  const inliers = points.filter((point) => Math.abs(point[key] - (best.slope * point.y + best.intercept)) < 8);
  let sumY = 0;
  let sumValue = 0;
  let sumYY = 0;
  let sumYValue = 0;
  inliers.forEach((point) => {
    sumY += point.y;
    sumValue += point[key];
    sumYY += point.y * point.y;
    sumYValue += point.y * point[key];
  });
  const denominator = inliers.length * sumYY - sumY * sumY || 1;
  const slope = (inliers.length * sumYValue - sumY * sumValue) / denominator;
  const intercept = (sumValue - slope * sumY) / inliers.length;
  const ys = inliers.map((point) => point.y).sort((a, b) => a - b);
  return {
    at: (y) => slope * y + intercept,
    y0: ys[Math.floor(ys.length * 0.04)],
    y1: ys[Math.floor(ys.length * 0.96)],
    count: inliers.length,
  };
}

export function findPageQuad(data, width, height) {
  const luma = new Float32Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    luma[index] = (data[offset] * 54 + data[offset + 1] * 183 + data[offset + 2] * 19) >> 8;
  }
  const blurred = blurLuma(luma, width, height, 3);
  const cornerValue = (originX, originY) => {
    let sum = 0;
    let count = 0;
    for (let y = originY; y < originY + 12 && y < height; y += 1) {
      for (let x = originX; x < originX + 12 && x < width; x += 1) {
        sum += blurred[y * width + x];
        count += 1;
      }
    }
    return count ? sum / count : 0;
  };
  const background = Math.min(
    cornerValue(2, 2),
    cornerValue(Math.max(0, width - 14), 2),
    cornerValue(2, Math.max(0, height - 14)),
    cornerValue(Math.max(0, width - 14), Math.max(0, height - 14)),
  );
  const center = [];
  const yStart = Math.floor(height * 0.3);
  const yEnd = Math.floor(height * 0.7);
  const xStart = Math.floor(width * 0.3);
  const xEnd = Math.floor(width * 0.7);
  for (let y = yStart; y < yEnd; y += 2) {
    for (let x = xStart; x < xEnd; x += 2) center.push(blurred[y * width + x]);
  }
  if (center.length < 20) return null;
  center.sort((a, b) => a - b);
  const paper = center[Math.floor(center.length * 0.75)];
  if (paper - background < 18) return null;
  const threshold = Math.max(background + 26, paper - 16);

  const rows = [];
  for (let y = 0; y < height; y += 1) {
    let left = -1;
    let right = -1;
    let count = 0;
    for (let x = 0; x < width; x += 1) {
      if (blurred[y * width + x] < threshold) continue;
      count += 1;
      if (left < 0) left = x;
      right = x;
    }
    const span = right - left;
    if (count > width * 0.18 && span > width * 0.22 && count / span > 0.42) rows.push({ y, left, right });
  }
  const leftLine = fitInlierLine(rows, 'left', height);
  const rightLine = fitInlierLine(rows, 'right', height);
  if (!leftLine || !rightLine) return null;

  let top = Math.max(leftLine.y0, rightLine.y0);
  let bottom = Math.min(leftLine.y1, rightLine.y1);
  const pageLevelAt = (y) => {
    const left = Math.floor(leftLine.at(y));
    const right = Math.floor(rightLine.at(y));
    if (right - left < width * 0.2 || y < 0 || y >= height) return 0;
    const inside = [];
    for (let x = Math.max(0, left); x < Math.min(width, right); x += 2) inside.push(blurred[y * width + x]);
    if (!inside.length) return 0;
    inside.sort((a, b) => a - b);
    return inside[Math.floor(inside.length * 0.65)];
  };
  const maxGap = Math.round(height * 0.2);
  let gap = 0;
  while (bottom < height - 2) {
    if (pageLevelAt(bottom + 1) >= threshold - 22) {
      bottom += 1;
      gap = 0;
    } else if (gap < maxGap) {
      bottom += 1;
      gap += 1;
    } else {
      bottom -= gap;
      gap = 0;
      break;
    }
  }
  if (gap > 0) bottom -= gap;
  let borderY = bottom;
  let dullRows = 0;
  const borderLimit = Math.min(height - 2, bottom + Math.round(height * 0.28));
  for (let y = bottom; y < borderLimit; y += 1) {
    if (pageLevelAt(y) < threshold - 22) {
      dullRows += 1;
      if (dullRows > 6) break;
    } else {
      dullRows = 0;
    }
    const left = Math.max(1, Math.floor(leftLine.at(y)));
    const right = Math.min(width - 2, Math.floor(rightLine.at(y)));
    if (right - left < width * 0.2) continue;
    let score = 0;
    for (let x = left; x < right; x += 1) {
      const index = y * width + x;
      if (Math.abs(luma[index + width] - luma[index - width]) > 20) score += 1;
    }
    if (score > (right - left) * 0.45) borderY = y;
  }
  bottom = Math.min(height - 1, borderY + 4);
  const pageHeight = bottom - top;
  const pageWidth = ((rightLine.at(top) - leftLine.at(top)) + (rightLine.at(bottom) - leftLine.at(bottom))) / 2;
  if (pageHeight < height * 0.35 || pageWidth < width * 0.28) return null;
  const insetY = pageHeight * 0.008;
  const insetX = pageWidth * 0.012;
  const clampX = (value) => Math.max(0, Math.min(width - 1, value));
  const clampY = (value) => Math.max(0, Math.min(height - 1, value));
  const quad = {
    tl: { x: clampX(leftLine.at(top + insetY) + insetX), y: clampY(top + insetY) },
    tr: { x: clampX(rightLine.at(top + insetY) - insetX), y: clampY(top + insetY) },
    bl: { x: clampX(leftLine.at(bottom - insetY) + insetX), y: clampY(bottom - insetY) },
    br: { x: clampX(rightLine.at(bottom - insetY) - insetX), y: clampY(bottom - insetY) },
  };
  const topWidth = quad.tr.x - quad.tl.x;
  const bottomWidth = quad.br.x - quad.bl.x;
  if (topWidth < width * 0.25 || bottomWidth < width * 0.25) return null;
  const area = ((topWidth + bottomWidth) / 2) * (quad.bl.y - quad.tl.y);
  const margin = 1 - area / (width * height);
  if (margin < 0.035) return null;
  return quad;
}

function sampleBilinear(source, sourceWidth, sourceHeight, x, y) {
  const maxX = sourceWidth - 1;
  const maxY = sourceHeight - 1;
  const clampedX = Math.max(0, Math.min(maxX, x));
  const clampedY = Math.max(0, Math.min(maxY, y));
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(maxX, x0 + 1);
  const y1 = Math.min(maxY, y0 + 1);
  const dx = clampedX - x0;
  const dy = clampedY - y0;
  const read = (px, py) => {
    const offset = (py * sourceWidth + px) * 4;
    return [source[offset], source[offset + 1], source[offset + 2]];
  };
  const topLeft = read(x0, y0);
  const topRight = read(x1, y0);
  const bottomLeft = read(x0, y1);
  const bottomRight = read(x1, y1);
  return [0, 1, 2].map((channel) => (
    topLeft[channel] * (1 - dx) * (1 - dy)
    + topRight[channel] * dx * (1 - dy)
    + bottomLeft[channel] * (1 - dx) * dy
    + bottomRight[channel] * dx * dy
  ));
}

function warpPage(image, quad) {
  const topWidth = Math.hypot(quad.tr.x - quad.tl.x, quad.tr.y - quad.tl.y);
  const bottomWidth = Math.hypot(quad.br.x - quad.bl.x, quad.br.y - quad.bl.y);
  const leftHeight = Math.hypot(quad.bl.x - quad.tl.x, quad.bl.y - quad.tl.y);
  const rightHeight = Math.hypot(quad.br.x - quad.tr.x, quad.br.y - quad.tr.y);
  const destWidth = Math.max(32, Math.round((topWidth + bottomWidth) / 2));
  const destHeight = Math.max(32, Math.round((leftHeight + rightHeight) / 2));
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = image.naturalWidth;
  sourceCanvas.height = image.naturalHeight;
  const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
  sourceContext.drawImage(image, 0, 0);
  const source = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height).data;
  const canvas = document.createElement('canvas');
  canvas.width = destWidth;
  canvas.height = destHeight;
  const context = canvas.getContext('2d');
  const output = context.createImageData(destWidth, destHeight);
  const { tl, tr, bl, br } = quad;
  for (let y = 0; y < destHeight; y += 1) {
    const v = destHeight === 1 ? 0 : y / (destHeight - 1);
    for (let x = 0; x < destWidth; x += 1) {
      const u = destWidth === 1 ? 0 : x / (destWidth - 1);
      const px = (1 - u) * (1 - v) * tl.x + u * (1 - v) * tr.x + (1 - u) * v * bl.x + u * v * br.x;
      const py = (1 - u) * (1 - v) * tl.y + u * (1 - v) * tr.y + (1 - u) * v * bl.y + u * v * br.y;
      const color = sampleBilinear(source, sourceCanvas.width, sourceCanvas.height, px, py);
      const offset = (y * destWidth + x) * 4;
      output.data[offset] = color[0];
      output.data[offset + 1] = color[1];
      output.data[offset + 2] = color[2];
      output.data[offset + 3] = 255;
    }
  }
  context.putImageData(output, 0, 0);
  return canvas;
}

export function findContentCrop(data, width, height, mode) {
  const background = estimateBackground(data, width, height);
  if (!background) return null;

  const luma = new Uint8Array(width * height);
  const gradient = new Uint8Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    luma[index] = (data[offset] * 54 + data[offset + 1] * 183 + data[offset + 2] * 19) >> 8;
  }
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const horizontal = Math.abs(luma[index + 1] - luma[index - 1]);
      const vertical = Math.abs(luma[index + width] - luma[index - width]);
      gradient[index] = Math.min(255, horizontal + vertical);
    }
  }

  const blocked = new Uint8Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    if (data[offset + 3] < 20) continue;
    if (gradient[index] >= 18 || colorDistanceSquared(data[offset], data[offset + 1], data[offset + 2], background) >= 12 * 12) {
      blocked[index] = 1;
    }
  }
  const content = dilateMask(blocked, width, height, 2);
  const empty = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const seed = (index) => {
    if (empty[index] || content[index]) return;
    empty[index] = 1;
    queue[tail] = index;
    tail += 1;
  };
  for (let x = 0; x < width; x += 1) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    seed(y * width);
    seed(y * width + width - 1);
  }
  while (head < tail) {
    const index = queue[head];
    head += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) seed(index - 1);
    if (x + 1 < width) seed(index + 1);
    if (y > 0) seed(index - width);
    if (y + 1 < height) seed(index + width);
  }

  const enclosed = new Uint8Array(width * height);
  for (let index = 0; index < enclosed.length; index += 1) {
    if (!empty[index]) enclosed[index] = 1;
  }
  const bounds = contentBounds(enclosed, width, height);
  if (!bounds || bounds.width < 24 || bounds.height < 24) return null;
  if ((bounds.width * bounds.height) / (width * height) < 0.04 && bounds.coverage < 0.9) return null;

  const sideMargin = {
    left: bounds.x / width,
    right: (width - bounds.x - bounds.width) / width,
    top: bounds.y / height,
    bottom: (height - bounds.y - bounds.height) / height,
  };
  const isDocument = bounds.coverage >= 0.9;
  const certificateInk = mode === 'certificate';
  const extraPassportSpace = mode === 'passport' && !isDocument && (
    sideMargin.left > 0.18
    || sideMargin.right > 0.18
    || sideMargin.left + sideMargin.right > 0.3
    || sideMargin.top > 0.2
    || sideMargin.bottom > 0.2
    || sideMargin.top + sideMargin.bottom > 0.34
  );
  if (!isDocument && !certificateInk && !extraPassportSpace) return null;
  if ((isDocument || certificateInk) && !hasMargin(bounds, width, height, 0.015)) return null;

  const cropped = (isDocument || certificateInk)
    ? expandRect(bounds, width, height, {
      left: bounds.width * 0.03,
      right: bounds.width * 0.03,
      top: bounds.height * 0.03,
      bottom: bounds.height * 0.03,
    })
    : expandRect(bounds, width, height, {
      left: bounds.width * 0.5,
      right: bounds.width * 0.5,
      top: bounds.height * 0.62,
      bottom: bounds.height * 0.38,
    });
  if (!hasMargin(cropped, width, height, extraPassportSpace ? 0.08 : 0.012)) return null;
  return cropped;
}

export async function cropEmptyMargins(file, mode) {
  const { image, url } = await loadImage(file);
  try {
    const sourceWidth = image.naturalWidth;
    const sourceHeight = image.naturalHeight;
    if (!sourceWidth || !sourceHeight) return { file, cropped: false, sourceWidth, sourceHeight };
    const scale = Math.min(1, CONTENT_ANALYSIS_MAX / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const analysis = document.createElement('canvas');
    analysis.width = width;
    analysis.height = height;
    const analysisContext = analysis.getContext('2d', { willReadFrequently: true });
    if (!analysisContext) return { file, cropped: false, sourceWidth, sourceHeight };
    analysisContext.drawImage(image, 0, 0, width, height);
    const pixels = analysisContext.getImageData(0, 0, width, height).data;
    const pageQuad = findPageQuad(pixels, width, height);
    if (pageQuad) {
      const xScale = sourceWidth / width;
      const yScale = sourceHeight / height;
      const mapPoint = (point) => ({ x: point.x * xScale, y: point.y * yScale });
      const canvas = warpPage(image, {
        tl: mapPoint(pageQuad.tl),
        tr: mapPoint(pageQuad.tr),
        bl: mapPoint(pageQuad.bl),
        br: mapPoint(pageQuad.br),
      });
      const blob = await canvasToJpeg(canvas, 0.97);
      const baseName = file.name.replace(/\.[^.]+$/, '') || (mode === 'passport' ? 'passport-photo' : 'certificate');
      return {
        file: new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' }),
        cropped: true,
        sourceWidth,
        sourceHeight,
        width: canvas.width,
        height: canvas.height,
      };
    }
    const rect = findContentCrop(pixels, width, height, mode);
    if (!rect) return { file, cropped: false, sourceWidth, sourceHeight };

    const xScale = sourceWidth / width;
    const yScale = sourceHeight / height;
    const sx = Math.max(0, Math.floor(rect.x * xScale));
    const sy = Math.max(0, Math.floor(rect.y * yScale));
    const sw = Math.min(sourceWidth - sx, Math.max(1, Math.round(rect.width * xScale)));
    const sh = Math.min(sourceHeight - sy, Math.max(1, Math.round(rect.height * yScale)));
    const removedWidth = 1 - sw / sourceWidth;
    const removedHeight = 1 - sh / sourceHeight;
    if (sw < 32 || sh < 32 || (removedWidth < 0.025 && removedHeight < 0.025)) {
      return { file, cropped: false, sourceWidth, sourceHeight };
    }

    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Your browser could not crop the empty space around this image.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, sw, sh);
    context.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    const blob = await canvasToJpeg(canvas, 0.97);
    const baseName = file.name.replace(/\.[^.]+$/, '') || (mode === 'passport' ? 'passport-photo' : 'certificate');
    return {
      file: new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' }),
      cropped: true,
      sourceWidth,
      sourceHeight,
      width: sw,
      height: sh,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function cropPortrait(file, face, outputWidth, outputHeight) {
  const { image, url } = await loadImage(file);
  try {
    const ratio = outputWidth / outputHeight;
    const imageWidth = image.naturalWidth;
    const imageHeight = image.naturalHeight;
    const faceHeight = face.height;
    let cropHeight = Math.min(imageHeight, imageWidth / ratio, faceHeight / 0.52);
    let cropWidth = cropHeight * ratio;
    if (cropWidth > imageWidth) {
      cropWidth = imageWidth;
      cropHeight = cropWidth / ratio;
    }

    const faceCenterX = face.originX + face.width / 2;
    const faceCenterY = face.originY + face.height / 2;
    let sourceX = faceCenterX - cropWidth / 2;
    let sourceY = faceCenterY - cropHeight * 0.42;
    sourceX = Math.max(0, Math.min(sourceX, imageWidth - cropWidth));
    sourceY = Math.max(0, Math.min(sourceY, imageHeight - cropHeight));

    const canvas = document.createElement('canvas');
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Your browser could not crop this portrait.');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, sourceX, sourceY, cropWidth, cropHeight, 0, 0, outputWidth, outputHeight);
    const blob = await canvasToJpeg(canvas, 0.96);
    return new File([blob], 'passport-photo.jpg', { type: 'image/jpeg' });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function compressImage(file, targetBytes, { allowDownscale = true } = {}) {
  const { image, url } = await loadImage(file);
  try {
    const sourceWidth = image.naturalWidth;
    const sourceHeight = image.naturalHeight;
    if (!sourceWidth || !sourceHeight) throw new Error('This image has no readable dimensions.');

    let width = sourceWidth;
    let height = sourceHeight;
    let best = await encode(image, width, height, 0.08);
    while (allowDownscale && best.size >= targetBytes && Math.max(width, height) > 320) {
      width = Math.max(1, Math.floor(width * 0.9));
      height = Math.max(1, Math.floor(height * 0.9));
      best = await encode(image, width, height, 0.08);
    }
    if (best.size >= targetBytes) {
      throw new Error(`This image could not be converted below ${Math.round(targetBytes / 1000)} KB.`);
    }

    let low = 0.08;
    let high = 0.96;
    for (let i = 0; i < 13; i += 1) {
      const quality = (low + high) / 2;
      const candidate = await encode(image, width, height, quality);
      if (candidate.size < targetBytes) {
        best = candidate;
        low = quality;
      } else {
        high = quality;
      }
    }
    return { blob: best, width, height, sourceWidth, sourceHeight, downscaled: width !== sourceWidth || height !== sourceHeight, reachedTarget: best.size < targetBytes };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function encode(image, width, height, quality) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return reject(new Error('Your browser could not prepare this image.'));
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not export this image. Please try another photo.')), 'image/jpeg', quality);
  });
}
