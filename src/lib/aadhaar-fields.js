const STATES = [
  ['andaman and nicobar', 'Andaman and Nicobar Islands'],
  ['andhra pradesh', 'Andhra Pradesh'],
  ['arunachal pradesh', 'Arunachal Pradesh'],
  ['dadra and nagar haveli and daman and diu', 'Dadra and Nagar Haveli and Daman and Diu'],
  ['dadra and nagar haveli', 'Dadra and Nagar Haveli and Daman and Diu'],
  ['daman and diu', 'Dadra and Nagar Haveli and Daman and Diu'],
  ['himachal pradesh', 'Himachal Pradesh'],
  ['jammu and kashmir', 'Jammu and Kashmir'],
  ['jammu & kashmir', 'Jammu and Kashmir'],
  ['madhya pradesh', 'Madhya Pradesh'],
  ['tamil nadu', 'Tamil Nadu'],
  ['uttar pradesh', 'Uttar Pradesh'],
  ['west bengal', 'West Bengal'],
  ['chhattisgarh', 'Chhattisgarh'],
  ['maharashtra', 'Maharashtra'],
  ['puducherry', 'Puducherry'],
  ['pondicherry', 'Puducherry'],
  ['uttarakhand', 'Uttarakhand'],
  ['chandigarh', 'Chandigarh'],
  ['lakshadweep', 'Lakshadweep'],
  ['telangana', 'Telangana'],
  ['karnataka', 'Karnataka'],
  ['jharkhand', 'Jharkhand'],
  ['meghalaya', 'Meghalaya'],
  ['nagaland', 'Nagaland'],
  ['rajasthan', 'Rajasthan'],
  ['new delhi', 'Delhi'],
  ['haryana', 'Haryana'],
  ['gujarat', 'Gujarat'],
  ['manipur', 'Manipur'],
  ['mizoram', 'Mizoram'],
  ['tripura', 'Tripura'],
  ['kerala', 'Kerala'],
  ['odisha', 'Odisha'],
  ['orissa', 'Odisha'],
  ['punjab', 'Punjab'],
  ['sikkim', 'Sikkim'],
  ['assam', 'Assam'],
  ['bihar', 'Bihar'],
  ['delhi', 'Delhi'],
  ['ladakh', 'Ladakh'],
  ['goa', 'Goa'],
].sort((left, right) => right[0].length - left[0].length);

const HEADER_LINE = /\b(government|aadhaa?r|uidai|unique identification|authority of india|income tax|date of birth|year of birth|gender|address|download|enrol+ment|virtual id|\bvid\b|meri pehchaan|my aadhaar|help@|www\.|signature)\b/i;

const EMPTY_FIELDS = {
  name: '',
  dateOfBirth: '',
  age: '',
  ageBasis: '',
  gender: '',
  careOf: '',
  house: '',
  street: '',
  landmark: '',
  locality: '',
  village: '',
  mandal: '',
  postOffice: '',
  district: '',
  state: '',
  pincode: '',
  aadhaarNumber: '',
  fullAddress: '',
};

function clean(value) {
  return (value || '').replace(/\s+/g, ' ').replace(/^[\s,:;|./\-–—]+|[\s,:;|./\-–—]+$/g, '').trim();
}

function matchState(text) {
  const lower = text.toLowerCase();
  const found = STATES.find(([needle]) => lower.includes(needle));
  return found ? found[1] : '';
}

function isStateSegment(segment) {
  const state = matchState(segment);
  if (!state) return false;
  const remainder = segment.toLowerCase().replace(state.toLowerCase(), '').replace(/\b(state|india)\b/g, '');
  return clean(remainder).length < 3;
}

export function ageFromDateOfBirth(value, today = new Date()) {
  const full = String(value || '').match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (full) {
    const day = Number(full[1]);
    const month = Number(full[2]);
    const year = Number(full[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > today.getFullYear()) return '';
    let age = today.getFullYear() - year;
    const birthdayReached = today.getMonth() + 1 > month || (today.getMonth() + 1 === month && today.getDate() >= day);
    if (!birthdayReached) age -= 1;
    return age >= 0 && age <= 130 ? String(age) : '';
  }
  const yearOnly = String(value || '').match(/\b((?:19|20)\d{2})\b/);
  if (!yearOnly) return '';
  const age = today.getFullYear() - Number(yearOnly[1]);
  return age >= 0 && age <= 130 ? String(age) : '';
}

function normalizeDate(value) {
  const full = value.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (!full) return value;
  let year = full[3];
  if (year.length === 2) year = Number(year) > 30 ? `19${year}` : `20${year}`;
  return `${full[1].padStart(2, '0')}/${full[2].padStart(2, '0')}/${year}`;
}

function formatAadhaar(digits) {
  const numbers = digits.replace(/\D/g, '');
  if (numbers.length !== 12) return '';
  return numbers.replace(/(\d{4})(?=\d)/g, '$1 ').trim();
}

function findAadhaarNumber(text) {
  const withoutVid = text.replace(/\b(?:vid|virtual\s+id)\b\s*[:\-]?\s*(?:\d[\s-]?){16}/gi, ' ');
  const labeled = withoutVid.match(/\baadhaa?r(?:\s*(?:no\.?|number))?\b\s*[:\-]?\s*((?:\d[\s-]?){12})/i)
    || withoutVid.match(/\byour\s+aadhaa?r\s+no\.?\b\s*[:\-]?\s*((?:\d[\s-]?){12})/i);
  if (labeled) return formatAadhaar(labeled[1]);
  const grouped = withoutVid.match(/(?<!\d)(\d{4})[ \t-]+(\d{4})[ \t-]+(\d{4})(?!\d)/);
  if (grouped) return `${grouped[1]} ${grouped[2]} ${grouped[3]}`;
  const tight = withoutVid.match(/(?<!\d)(\d{12})(?!\d)/);
  return tight ? formatAadhaar(tight[1]) : '';
}

function canonicalGender(value) {
  const normalized = value.toLowerCase();
  if (normalized.startsWith('m')) return 'Male';
  if (normalized.startsWith('f')) return 'Female';
  if (normalized.startsWith('t') || normalized.startsWith('o')) return 'Transgender';
  return '';
}

function extractGender(text, lines) {
  const labeled = text.match(/\b(?:gender|sex)\b\s*[:\-]?\s*(male|female|transgender|trans|others?)\b/i);
  if (labeled) return canonicalGender(labeled[1]);
  const exact = lines.find((line) => /^(?:male|female|transgender)$/i.test(line));
  if (exact) return canonicalGender(exact);
  const loose = text.match(/\b(male|female|transgender)\b/i);
  return loose ? canonicalGender(loose[1]) : '';
}

function extractDateOfBirth(text) {
  const labeled = text.match(/\b(?:date\s+of\s+birth|birth\s+date|d\.?\s*o\.?\s*b\.?|dob|year\s+of\s+birth|y\.?\s*o\.?\s*b\.?|yob)\b\s*[:\-]?\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|(?:19|20)\d{2})/i);
  if (labeled) {
    const value = normalizeDate(labeled[1]);
    const basis = /year\s+of\s+birth|y\.?\s*o\.?\s*b|yob/i.test(labeled[0]) && !labeled[1].includes('/') && !labeled[1].includes('-') && !labeled[1].includes('.')
      ? 'year'
      : (value.includes('/') ? 'date' : 'year');
    return { value, basis };
  }
  const anyDate = text.match(/\b(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})\b/);
  if (anyDate) return { value: normalizeDate(anyDate[1]), basis: 'date' };
  return { value: '', basis: '' };
}

function isPersonName(line, allowSingle) {
  const value = clean(line);
  if (value.length < 3 || value.length > 60) return false;
  if (HEADER_LINE.test(value) || isStateSegment(value)) return false;
  if (/\d|\//.test(value)) return false;
  if (!/^[A-Za-z][A-Za-z .']+$/.test(value)) return false;
  const words = value.split(/\s+/);
  if (words.length > 5 || (words.length < 2 && !allowSingle)) return false;
  return /[aeiou]/i.test(value);
}

function extractName(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const labeled = lines[index].match(/^(?:name(?:\s+of\s+(?:the\s+)?(?:resident|holder|applicant))?)\s*[:#–—-]\s*(.*)$/i)
      || lines[index].match(/^(?:name(?:\s+of\s+(?:the\s+)?(?:resident|holder|applicant))?)\s+([A-Za-z].*)$/i);
    if (labeled && isPersonName(labeled[1], true)) return clean(labeled[1]);
    if (/^name$/i.test(lines[index]) && isPersonName(lines[index + 1] || '', true)) return clean(lines[index + 1]);
  }
  const toIndex = lines.findIndex((line) => /^to$/i.test(line));
  if (toIndex >= 0 && isPersonName(lines[toIndex + 1] || '', false)) return clean(lines[toIndex + 1]);
  const dobIndex = lines.findIndex((line) => /\b(dob|d\.?\s*o\.?\s*b|date of birth|year of birth|yob)\b/i.test(line));
  if (dobIndex > 0) {
    for (let index = dobIndex - 1; index >= 0; index -= 1) {
      const sameLine = lines[index].split(/\b(?:dob|d\.?\s*o\.?\s*b|date of birth|year of birth)\b/i)[0];
      if (isPersonName(sameLine, false)) return clean(sameLine);
    }
  }
  return '';
}

function addressLines(lines) {
  const start = lines.findIndex((line) => /\baddress\b/i.test(line));
  if (start >= 0) {
    const collected = [];
    for (let index = start; index < lines.length; index += 1) {
      const line = lines[index];
      if (index > start && (
        /^(?:name|dob|date of birth|gender|aadhaa?r|your aadhaar|vid\b|virtual|help@|www\.|uidai|download|enrol|signature|unique identification)\b/i.test(line)
        || /\b(?:unique identification|uidai)\b/i.test(line)
        || /(?<!\d)(?:\d{4}[ \t-]+){2}\d{4}(?!\d)/.test(line)
        || /(?<!\d)\d{12}(?!\d)/.test(line)
      )) break;
      const value = index === start ? line.replace(/^.*\baddress\b\s*[:\-–—]?\s*/i, '') : line;
      if (clean(value)) collected.push(clean(value));
    }
    if (collected.length) return collected;
  }
  const pinIndex = lines.findIndex((line) => /\b[1-9]\d{5}\b/.test(line) && !/\baadhaa?r\b/i.test(line));
  if (pinIndex < 0) return [];
  return lines.slice(Math.max(0, pinIndex - 6), pinIndex + 1)
    .filter((line) => !HEADER_LINE.test(line) && !/\baadhaa?r\b/i.test(line))
    .map((line) => clean(line))
    .filter(Boolean);
}

function setField(fields, key, value) {
  const next = clean(value);
  if (next && !fields[key]) fields[key] = next;
}

function consumeAddressSegment(segment, fields, leftovers, pending) {
  if (!segment || isStateSegment(segment)) return pending;
  if (pending) {
    setField(fields, pending, segment);
    return '';
  }

  const leading = segment.match(/^(care of|son of|daughter of|wife of|c\/o|s\/o|d\/o|w\/o|street(?:\s*name)?|village(?:\s*name)?|vtc|mandal(?:\s*name)?|sub\s*district|district|state|landmark|locality|house(?:\s*no\.?)?|h\.?\s*no\.?|door(?:\s*no\.?)?|post\s*office|p\.?\s*o\.?|pin(?:\s*code)?|pincode)\s*[:\-–—]?\s+(.+)$/i);
  if (leading) {
    const label = leading[1].toLowerCase();
    const value = leading[2];
    if (/care of|son of|daughter of|wife of|[cdsw]\/o/.test(label)) setField(fields, 'careOf', `${leading[1]} ${value}`);
    else if (label.startsWith('street')) setField(fields, 'street', value);
    else if (label.startsWith('village') || label === 'vtc') setField(fields, 'village', value);
    else if (label.startsWith('mandal') || label.startsWith('sub')) setField(fields, 'mandal', value);
    else if (label.startsWith('district')) setField(fields, 'district', value);
    else if (label.startsWith('state')) setField(fields, 'state', matchState(value) || value);
    else if (label.startsWith('landmark')) setField(fields, 'landmark', value);
    else if (label.startsWith('locality')) setField(fields, 'locality', value);
    else if (label.startsWith('house') || label.startsWith('h') || label.startsWith('door')) setField(fields, 'house', value);
    else if (label.startsWith('post') || /^p\.?\s*o\.?$/.test(label)) setField(fields, 'postOffice', value);
    else if (label.startsWith('pin')) setField(fields, 'pincode', value.match(/[1-9]\d{5}/)?.[0] || value);
    return pending;
  }

  if (/^(?:street(?:\s*name)?|village(?:\s*name)?|vtc|mandal(?:\s*name)?|sub\s*district|district|landmark|locality|house(?:\s*no\.?)?|post\s*office|pin(?:\s*code)?|pincode)$/i.test(segment)) {
    const label = segment.toLowerCase();
    if (label.startsWith('street')) return 'street';
    if (label.startsWith('village') || label === 'vtc') return 'village';
    if (label.startsWith('mandal') || label.startsWith('sub')) return 'mandal';
    if (label.startsWith('district')) return 'district';
    if (label.startsWith('landmark')) return 'landmark';
    if (label.startsWith('locality')) return 'locality';
    if (label.startsWith('house')) return 'house';
    if (label.startsWith('post')) return 'postOffice';
    return 'pincode';
  }

  if (/^(?:c\/o|s\/o|d\/o|w\/o|son of|daughter of|wife of|care of)\b/i.test(segment)) {
    setField(fields, 'careOf', segment.replace(/\b(s\/o|d\/o|w\/o|c\/o)\b/gi, (match) => match.toUpperCase()));
    return pending;
  }
  if (/^(?:h\.?\s*no\.?|house(?:\s*no\.?)?|door(?:\s*no\.?)?|d\.?\s*no\.?|flat|plot|apartment|building)\b/i.test(segment) || /^\d{1,5}(?:[\/\-]\d{1,5}){0,3}$/.test(segment)) {
    setField(fields, 'house', segment);
    return pending;
  }
  const doorAndRest = segment.match(/^(\d{1,5}(?:[\/\-]\d{1,5}){1,3})\s+(.+)$/);
  if (doorAndRest) {
    setField(fields, 'house', doorAndRest[1]);
    return consumeAddressSegment(doorAndRest[2], fields, leftovers, pending);
  }
  if (/\b(?:mandal|mandalam|sub\s*district|tehsil|taluk|taluka)\b/i.test(segment)) {
    setField(fields, 'mandal', segment.replace(/\b(?:mandal|mandalam|sub\s*district|tehsil|taluk|taluka)\b/ig, ''));
    return pending;
  }
  if (/\b(?:village|vtc|gramam|grama)\b/i.test(segment)) {
    setField(fields, 'village', segment.replace(/\b(?:village|vtc|gramam|grama)\b/ig, ''));
    return pending;
  }
  if (/^(?:p\.?\s*o\.?|post\s*office)\b/i.test(segment)) {
    setField(fields, 'postOffice', segment.replace(/^(?:p\.?\s*o\.?|post\s*office)\b\s*[:\-–—]?\s*/i, ''));
    return pending;
  }
  if (/\b(?:district|dist)\b/i.test(segment)) {
    setField(fields, 'district', segment.replace(/\b(?:district|dist)\b/ig, ''));
    return pending;
  }
  if (/\b(?:landmark|near|opposite|opp\.?|beside|behind)\b/i.test(segment)) {
    setField(fields, 'landmark', segment);
    return pending;
  }
  if (/\b(?:street|road|lane|marg|cross|avenue|bazaar|bazar)\b/i.test(segment)) {
    setField(fields, 'street', segment);
    return pending;
  }
  if (/\b(?:locality|colony|sector|layout|ward)\b/i.test(segment)) {
    setField(fields, 'locality', segment);
    return pending;
  }
  leftovers.push(segment);
  return pending;
}

function looksLikeStreet(value) {
  return /\b(?:street|road|rd|lane|marg|cross|avenue|bazaar|bazar|main)\b/i.test(value) || /\d/.test(value);
}

function assignLeftovers(parts, fields) {
  const queue = parts.map((part) => clean(part)).filter(Boolean);
  if (!queue.length) return;
  if (queue.length === 1) {
    const only = queue[0];
    if (!fields.village && !looksLikeStreet(only)) fields.village = only;
    else if (!fields.street && (looksLikeStreet(only) || fields.village)) fields.street = only;
    else if (!fields.locality) fields.locality = only;
    else if (!fields.village) fields.village = only;
    else if (!fields.mandal) fields.mandal = only;
    else if (!fields.district) fields.district = only;
    return;
  }
  const order = ['street', 'locality', 'village', 'mandal', 'district'];
  queue.forEach((part) => {
    const key = order.find((field) => !fields[field]);
    if (key) fields[key] = part;
    else fields.locality = fields.locality ? `${fields.locality}, ${part}` : part;
  });
}

function parseAddress(lines, aadhaarNumber) {
  const selected = addressLines(lines);
  const fields = {
    careOf: '', house: '', street: '', landmark: '', locality: '', village: '', mandal: '', postOffice: '', district: '', state: '', pincode: '', fullAddress: '',
  };
  if (!selected.length) return fields;
  const blob = selected.join(', ');
  fields.fullAddress = blob;
  fields.state = matchState(blob);
  const aadhaarDigits = (aadhaarNumber || '').replace(/\D/g, '');
  const pins = blob.match(/\b[1-9]\d{5}\b/g) || [];
  fields.pincode = pins.find((pin) => !aadhaarDigits.includes(pin)) || '';
  const leftovers = [];
  let pending = '';
  selected.forEach((line) => {
    const withoutPin = line.replace(/\b[1-9]\d{5}\b/g, ' ');
    withoutPin.split(/[,;|]/).map((part) => clean(part)).filter(Boolean).forEach((part) => {
      pending = consumeAddressSegment(part, fields, leftovers, pending);
    });
  });
  assignLeftovers(leftovers, fields);
  return fields;
}

function detectSide(fields) {
  const identity = [fields.name, fields.dateOfBirth, fields.gender].filter(Boolean).length;
  const address = [fields.street, fields.village, fields.mandal, fields.pincode, fields.district, fields.house].filter(Boolean).length;
  if (identity && address) return 'full';
  if (address) return 'back';
  if (identity || fields.aadhaarNumber) return 'front';
  return 'partial';
}

function isAadhaar(text, fields) {
  if (/\bpassport\b/i.test(text) && !/\baadhaa?r\b/i.test(text)) return false;
  const mentionsAadhaar = /\baadhaa?r\b|\buidai\b|unique identification/i.test(text);
  if (fields.aadhaarNumber && (mentionsAadhaar || fields.dateOfBirth || fields.gender || fields.pincode || fields.name)) return true;
  if (mentionsAadhaar && (fields.name || fields.dateOfBirth || fields.pincode || fields.village || fields.mandal)) return true;
  if (fields.name && fields.dateOfBirth && fields.gender) return true;
  return Boolean(fields.pincode && (fields.village || fields.mandal) && (fields.state || fields.district));
}

export function parseAadhaarText(text, today = new Date()) {
  const normalized = String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[|]/g, ' ')
    .replace(/\b([CDSW])\s*\/\s*0\b/gi, (_, letter) => `${letter.toUpperCase()}/O`)
    .replace(/\b5\s*\/\s*O\b/g, 'S/O');
  const lines = normalized.split(/\r?\n/).map((line) => clean(line)).filter(Boolean);
  const flat = lines.join('\n');
  const dateOfBirth = extractDateOfBirth(flat);
  const aadhaarNumber = findAadhaarNumber(flat);
  const fields = {
    ...EMPTY_FIELDS,
    name: extractName(lines),
    dateOfBirth: dateOfBirth.value,
    age: ageFromDateOfBirth(dateOfBirth.value, today),
    ageBasis: dateOfBirth.value ? dateOfBirth.basis : '',
    gender: extractGender(flat, lines),
    aadhaarNumber,
    ...parseAddress(lines, aadhaarNumber),
  };
  const ok = lines.join(' ').length > 20 && isAadhaar(flat, fields);
  return {
    ok,
    side: detectSide(fields),
    fields,
    message: ok ? '' : 'We couldn’t read this as an Aadhaar card. Upload a clear photo or PDF of the full card, the front, or the back.',
  };
}
