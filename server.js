const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const childProcess = require("child_process");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 5199);
const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, "public");
const APP_NAME = "Search Internal Files";
const TARGET_ROOT_NAME = "Sandeep Taterway - Mergen Compass";
const ONEDRIVE_ROOT = discoverOneDriveRoot(APP_DIR);

const SUPPORTED_EXTS = new Set([
  ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".txt", ".md", ".csv"
]);
const MAX_FILE_BYTES = 260 * 1024 * 1024;
const MAX_SNIPPETS_PER_FILE = 8;
const MAX_SECTION_CHARS = 1800;
const RESCAN_DEBOUNCE_MS = 1000;
const FILE_EXTRACT_TIMEOUT_MS = 35000;

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "how", "in", "into",
  "is", "it", "its", "of", "on", "or", "our", "that", "the", "their", "this", "to", "was", "were",
  "what", "when", "where", "which", "who", "why", "with", "you", "your", "about", "all", "any", "can",
  "could", "should", "we", "they", "them", "these", "those", "will"
]);

const CONCEPTS = [
  {
    keys: ["gtm", "go to market", "go-to-market", "market launch"],
    related: [
      "gtm strategy", "go to market", "go-to-market", "market launch", "launch plan", "launch strategy",
      "commercial launch", "route to market", "channel strategy", "sales motion", "demand generation",
      "lead generation", "sales funnel", "pipeline", "customer acquisition", "pricing strategy"
    ]
  },
  {
    keys: ["sales funnel", "pipeline", "sales process"],
    related: [
      "sales funnel", "sales pipeline", "lead funnel", "prospecting", "qualification", "conversion",
      "win rate", "opportunity", "deal stage", "sales motion", "customer acquisition"
    ]
  },
  {
    keys: ["pricing", "pricing strategy", "monetization", "commercial model"],
    related: [
      "pricing strategy", "price positioning", "pricing model", "pricing architecture", "commercial model",
      "revenue model", "monetization", "packaging", "subscription", "discounting", "margin", "unit economics"
    ]
  },
  {
    keys: ["customer onboarding", "consumer onboarding", "user onboarding", "onboarding"],
    related: [
      "customer onboarding", "consumer onboarding", "user onboarding", "activation", "signup", "registration",
      "first use", "adoption", "customer journey", "welcome flow"
    ]
  },
  {
    keys: ["strategy", "growth strategy", "business strategy"],
    related: [
      "strategy", "growth strategy", "roadmap", "market opportunity", "competitive positioning",
      "business model", "operating model", "workstream", "initiative", "value proposition"
    ]
  },
  {
    keys: ["brand", "branding", "positioning"],
    related: [
      "brand", "branding", "brand strategy", "positioning", "messaging", "value proposition",
      "differentiation", "identity", "campaign"
    ]
  }
];

const PDF_REPAIR_WORDS = Array.from(new Set(
  CONCEPTS.flatMap((concept) => [...concept.keys, ...concept.related])
    .flatMap((phrase) => normalize(phrase).split(" "))
    .concat([
      "activation", "advertising", "analytics", "business", "campaign", "channel", "commercial", "consumer",
      "conversion", "customer", "deliverable", "digital", "funnel", "growth", "insight", "journey", "launch",
      "market", "marketing", "model", "onboarding", "pipeline", "pricing", "process", "revenue", "sales",
      "strategy", "workstream"
    ])
    .filter((word) => word.length >= 4)
));

const state = {
  rootPath: ONEDRIVE_ROOT,
  index: new Map(),
  scanning: false,
  queuedScan: false,
  scanTimer: null,
  currentFile: "",
  currentFolder: "",
  scannedFiles: 0,
  indexedFiles: 0,
  failedFiles: 0,
  skippedFiles: 0,
  totalBytes: 0,
  typeCounts: {},
  lastScanStarted: null,
  lastScanFinished: null,
  errors: [],
  messages: []
};

function nowIso() {
  return new Date().toISOString();
}

function fileId(filePath) {
  return Buffer.from(filePath, "utf8").toString("base64url");
}

function pushMessage(message) {
  state.messages.unshift({ time: nowIso(), message });
  state.messages = state.messages.slice(0, 20);
}

function pushError(message) {
  state.errors.unshift({ time: nowIso(), message });
  state.errors = state.errors.slice(0, 20);
}

function discoverOneDriveRoot(startDir) {
  const configuredRoot = process.env.SEARCH_INTERNAL_FILES_ROOT;
  if (configuredRoot) return path.resolve(configuredRoot);

  const resolvedStart = path.resolve(startDir);
  const namedAncestor = findAncestorByName(resolvedStart, TARGET_ROOT_NAME);
  if (namedAncestor) return namedAncestor;

  const envRoots = [
    process.env.OneDriveCommercial,
    process.env.OneDriveConsumer,
    process.env.OneDrive
  ].filter(Boolean).map((item) => path.resolve(item));

  const envMatch = envRoots
    .filter((candidate) => isPathInside(resolvedStart, candidate))
    .sort((a, b) => b.length - a.length)[0];
  if (envMatch) return envMatch;

  let current = resolvedStart;
  while (true) {
    const base = path.basename(current);
    if (/^OneDrive(\b| - )/i.test(base)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolvedStart;
}

function findAncestorByName(startDir, targetName) {
  let current = path.resolve(startDir);
  const target = targetName.toLowerCase();
  while (true) {
    if (path.basename(current).toLowerCase() === target) return current;
    const parent = path.dirname(current);
    if (parent === current) return "";
    current = parent;
  }
}

function isPathInside(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSupportedFile(filePath) {
  return SUPPORTED_EXTS.has(path.extname(filePath).toLowerCase());
}

function shouldSkipDirectory(dirPath, name) {
  const lowered = String(name || path.basename(dirPath)).toLowerCase();
  if (isPathInside(dirPath, APP_DIR)) return true;
  if (lowered === ".git" || lowered === "node_modules" || lowered === "$recycle.bin") return true;
  if (lowered === "system volume information" || lowered === ".cache" || lowered === ".codex") return true;
  if (lowered === "appdata" && dirPath.toLowerCase().includes(`${path.sep}users${path.sep}`)) return true;
  return false;
}

function enqueueScan(reason = "Manual refresh") {
  if (state.scanTimer) clearTimeout(state.scanTimer);
  state.scanTimer = setTimeout(() => {
    state.scanTimer = null;
    runScan(reason).catch((error) => pushError(error.message));
  }, RESCAN_DEBOUNCE_MS);
}

async function runScan(reason = "Manual refresh") {
  if (state.scanning) {
    state.queuedScan = true;
    return;
  }

  state.scanning = true;
  state.queuedScan = false;
  state.currentFile = "";
  state.currentFolder = state.rootPath;
  state.scannedFiles = 0;
  state.indexedFiles = 0;
  state.failedFiles = 0;
  state.skippedFiles = 0;
  state.totalBytes = 0;
  state.lastScanStarted = nowIso();
  pushMessage(`${reason}: scanning ${state.rootPath}`);

  const seen = new Set();

  try {
    await walkFiles(state.rootPath, async (filePath, stat) => {
      const resolved = path.resolve(filePath);
      seen.add(resolved);
      state.scannedFiles += 1;
      state.currentFile = resolved;
      state.totalBytes += stat.size;

      if (stat.size > MAX_FILE_BYTES) {
        state.skippedFiles += 1;
        return;
      }

      try {
        const record = await indexFile(resolved, stat);
        if (!record.sections.length) state.skippedFiles += 1;
      } catch (error) {
        state.failedFiles += 1;
        pushError(`${path.basename(resolved)}: ${error.message}`);
      }
    });

    for (const filePath of Array.from(state.index.keys())) {
      if (!seen.has(filePath)) state.index.delete(filePath);
    }
    refreshCounters();
    state.lastScanFinished = nowIso();
    pushMessage(`Finished scanning ${state.indexedFiles} readable files`);
  } finally {
    state.scanning = false;
    state.currentFile = "";
    if (state.queuedScan) enqueueScan("Queued refresh");
  }
}

async function walkFiles(folderPath, onFile) {
  state.currentFolder = folderPath;
  let entries;
  try {
    entries = await fsp.readdir(folderPath, { withFileTypes: true });
  } catch (error) {
    pushError(`Cannot read ${folderPath}: ${error.message}`);
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(folderPath, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(fullPath, entry.name)) await walkFiles(fullPath, onFile);
      continue;
    }
    if (!entry.isFile() || !isSupportedFile(fullPath)) continue;
    try {
      const stat = await fsp.stat(fullPath);
      await onFile(fullPath, stat);
    } catch (error) {
      pushError(`Cannot inspect ${fullPath}: ${error.message}`);
    }
  }
}

async function indexFile(filePath, stat) {
  const existing = state.index.get(filePath);
  if (existing && existing.modifiedMs === stat.mtimeMs && existing.size === stat.size) return existing;

  const ext = path.extname(filePath).toLowerCase();
  const sections = prepareSections(await extractSectionsInWorker(filePath, ext));
  const record = {
    id: fileId(filePath),
    path: filePath,
    fileName: path.basename(filePath),
    folder: inferFolder(filePath),
    category: inferCategory(filePath, ext),
    extension: ext.replace(".", "").toUpperCase(),
    size: stat.size,
    modifiedMs: stat.mtimeMs,
    modifiedAt: stat.mtime.toISOString(),
    indexedAt: nowIso(),
    sections,
    termSections: buildTermSections(sections)
  };
  state.index.set(filePath, record);
  refreshCounters();
  return record;
}

function prepareSections(sections) {
  return sections
    .map((section) => ({
      label: section.label,
      text: cleanText(section.text),
      tokens: Array.from(new Set(tokenize(section.text)))
    }))
    .filter((section) => section.text);
}

function buildTermSections(sections) {
  const termSections = {};
  sections.forEach((section, index) => {
    for (const token of section.tokens || []) {
      if (!termSections[token]) termSections[token] = [];
      termSections[token].push(index);
    }
  });
  return termSections;
}

function refreshCounters() {
  const records = Array.from(state.index.values());
  state.indexedFiles = records.filter((record) => record.sections.length > 0).length;
  state.failedFiles = state.failedFiles || 0;
  state.typeCounts = records.reduce((acc, record) => {
    acc[record.extension] = (acc[record.extension] || 0) + 1;
    return acc;
  }, {});
}

function inferFolder(filePath) {
  const rel = path.relative(state.rootPath, filePath);
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (parts.length > 1) return parts[0];
  return path.basename(state.rootPath);
}

function inferCategory(filePath, ext) {
  const haystack = `${path.basename(filePath)} ${path.dirname(filePath)}`.toLowerCase();
  if (/\b(gtm|go[- ]?to[- ]?market|launch|sales|funnel|pipeline)\b/.test(haystack)) return "Sales and GTM";
  if (/\b(pricing|commercial|revenue|margin|monetization)\b/.test(haystack)) return "Pricing and Commercial";
  if (/\b(onboarding|consumer|customer|journey|activation)\b/.test(haystack)) return "Customer Experience";
  if (/\b(strategy|roadmap|planning|growth|market)\b/.test(haystack)) return "Strategy";
  if (/\b(transcript|meeting|notes|interview)\b/.test(haystack)) return "Meetings and Notes";
  if (/\b(data|analysis|model|forecast|financial|finance)\b/.test(haystack)) return "Analysis and Models";
  if (ext === ".ppt" || ext === ".pptx") return "Presentations";
  if (ext === ".xls" || ext === ".xlsx" || ext === ".csv") return "Spreadsheets";
  if (ext === ".doc" || ext === ".docx") return "Documents";
  if (ext === ".pdf") return "PDFs";
  return "Other";
}

function extractSections(filePath, ext) {
  if (ext === ".txt" || ext === ".md" || ext === ".csv") return extractTextFile(filePath);
  if (ext === ".docx") return extractDocx(filePath);
  if (ext === ".pptx") return extractPptx(filePath);
  if (ext === ".xlsx") return extractXlsx(filePath);
  if (ext === ".pdf") return extractPdf(filePath);
  return extractBinaryOffice(filePath, ext);
}

function extractSectionsInWorker(filePath, ext) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {
      workerData: { action: "extract", filePath, ext }
    });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => {});
      reject(new Error(`Timed out reading file after ${Math.round(FILE_EXTRACT_TIMEOUT_MS / 1000)} seconds`));
    }, FILE_EXTRACT_TIMEOUT_MS);

    worker.on("message", (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (message.error) reject(new Error(message.error));
      else resolve(message.sections || []);
    });
    worker.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });
    worker.on("exit", (code) => {
      if (!settled && code !== 0) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Extractor stopped with code ${code}`));
      }
    });
  });
}

function extractTextFile(filePath) {
  const text = decodeTextBuffer(fs.readFileSync(filePath));
  return textToSections(text, "Text");
}

function extractDocx(filePath) {
  const zip = readZip(filePath);
  const xmlNames = Object.keys(zip).filter((name) =>
    /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/i.test(name)
  );
  const sections = [];
  let paragraph = 1;
  for (const name of xmlNames) {
    const xml = zip[name].toString("utf8");
    const blocks = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) || [];
    for (const block of blocks) {
      const text = cleanText(extractXmlTexts(block, "w:t").join("").replace(/<w:tab\/>/g, "\t"));
      if (text) sections.push({ label: `Word paragraph ${paragraph++}`, text });
    }
  }
  return sections;
}

function extractPptx(filePath) {
  const zip = readZip(filePath);
  const slideNames = Object.keys(zip)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/i)?.[1] || 0) - Number(b.match(/slide(\d+)/i)?.[1] || 0));
  const sections = [];
  for (const name of slideNames) {
    const slideNumber = Number(name.match(/slide(\d+)/i)?.[1] || sections.length + 1);
    const xml = zip[name].toString("utf8");
    const blocks = xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) || [];
    let paragraph = 1;
    for (const block of blocks) {
      const text = cleanText(extractXmlTexts(block, "a:t").join(" "));
      if (text) sections.push({ label: `Slide ${slideNumber}, paragraph ${paragraph++}`, text });
    }
  }
  return sections;
}

function extractXlsx(filePath) {
  const zip = readZip(filePath);
  const sharedStrings = parseSharedStrings(zip["xl/sharedStrings.xml"]);
  const sheetNames = parseWorkbookSheets(zip);
  const sheetPaths = Object.keys(zip)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/sheet(\d+)/i)?.[1] || 0) - Number(b.match(/sheet(\d+)/i)?.[1] || 0));
  const sections = [];

  for (const sheetPath of sheetPaths) {
    const sheetNumber = Number(sheetPath.match(/sheet(\d+)/i)?.[1] || sections.length + 1);
    const sheetName = sheetNames.get(sheetPath) || `Sheet ${sheetNumber}`;
    const xml = zip[sheetPath].toString("utf8");
    const rowRegex = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(xml))) {
      const rowNumber = attr(rowMatch[1], "r") || "";
      const cellText = [];
      const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
      let cellMatch;
      while ((cellMatch = cellRegex.exec(rowMatch[2]))) {
        const attrs = cellMatch[1];
        const body = cellMatch[2];
        const type = attr(attrs, "t");
        let value = "";
        if (type === "s") {
          const index = Number((body.match(/<v>([\s\S]*?)<\/v>/) || [])[1]);
          value = Number.isFinite(index) ? sharedStrings[index] || "" : "";
        } else if (type === "inlineStr") {
          value = extractXmlTexts(body, "t").join(" ");
        } else {
          value = decodeXml((body.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || "");
        }
        value = cleanText(value);
        if (value) cellText.push(value);
      }
      const text = cleanText(cellText.join(" | "));
      if (text) sections.push({ label: `${sheetName} row ${rowNumber || sections.length + 1}`, text });
    }
  }
  return sections;
}

function extractPdf(filePath) {
  const buffer = fs.readFileSync(filePath);
  const sections = [];
  const streamMarker = Buffer.from("stream");
  const endMarker = Buffer.from("endstream");
  let position = 0;
  let blockNumber = 1;

  while (position < buffer.length) {
    const streamAt = buffer.indexOf(streamMarker, position);
    if (streamAt === -1) break;
    let dataStart = streamAt + streamMarker.length;
    if (buffer[dataStart] === 13 && buffer[dataStart + 1] === 10) dataStart += 2;
    else if (buffer[dataStart] === 10 || buffer[dataStart] === 13) dataStart += 1;
    const endAt = buffer.indexOf(endMarker, dataStart);
    if (endAt === -1) break;

    const dict = buffer.slice(Math.max(0, streamAt - 2500), streamAt).toString("latin1");
    const decoded = decodePdfStream(buffer.slice(dataStart, endAt), dict);
    const text = decoded ? repairPdfText(cleanText(extractPdfTextOperators(decoded))) : "";
    if (text && likelyHumanText(text)) sections.push({ label: `PDF text block ${blockNumber++}`, text });
    position = endAt + endMarker.length;
  }

  if (!sections.length) {
    const fallback = repairPdfText(cleanText(extractPrintableText(buffer)));
    return textToSections(fallback, "PDF text");
  }
  return sections;
}

function extractBinaryOffice(filePath, ext) {
  const text = cleanText(extractPrintableText(fs.readFileSync(filePath)));
  const label = ext === ".doc" ? "Word binary text" : ext === ".ppt" ? "PowerPoint binary text" : "Spreadsheet binary text";
  return textToSections(text, label);
}

function decodeTextBuffer(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString("utf16le");
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return swapUtf16(buffer.slice(2)).toString("utf16le");
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.slice(3).toString("utf8");
  return buffer.toString("utf8");
}

function swapUtf16(buffer) {
  const out = Buffer.from(buffer);
  for (let i = 0; i + 1 < out.length; i += 2) {
    const temp = out[i];
    out[i] = out[i + 1];
    out[i + 1] = temp;
  }
  return out;
}

function textToSections(text, labelBase) {
  const cleaned = cleanText(text);
  if (!cleaned) return [];
  const paragraphs = cleaned
    .split(/\n{2,}|(?<=\.)\s+(?=[A-Z0-9])/)
    .map((part) => cleanText(part))
    .filter(Boolean);
  const source = paragraphs.length > 1 ? paragraphs : chunkText(cleaned, MAX_SECTION_CHARS);
  return source.flatMap((paragraph, index) => {
    if (paragraph.length <= MAX_SECTION_CHARS) return [{ label: `${labelBase} ${index + 1}`, text: paragraph }];
    return chunkText(paragraph, MAX_SECTION_CHARS).map((chunk, chunkIndex) => ({
      label: `${labelBase} ${index + 1}.${chunkIndex + 1}`,
      text: chunk
    }));
  });
}

function chunkText(text, size) {
  const chunks = [];
  for (let start = 0; start < text.length; start += size) chunks.push(text.slice(start, start + size));
  return chunks;
}

function readZip(filePath) {
  const buffer = fs.readFileSync(filePath);
  const eocdSig = 0x06054b50;
  let eocd = -1;
  const searchStart = Math.max(0, buffer.length - 70000);
  for (let i = buffer.length - 22; i >= searchStart; i--) {
    if (buffer.readUInt32LE(i) === eocdSig) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP directory not found");

  const centralDirectorySize = buffer.readUInt32LE(eocd + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocd + 16);
  const end = centralDirectoryOffset + centralDirectorySize;
  const entries = {};
  let offset = centralDirectoryOffset;

  while (offset < end && buffer.readUInt32LE(offset) === 0x02014b50) {
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.slice(offset + 46, offset + 46 + fileNameLength).toString("utf8");

    if (!fileName.endsWith("/")) {
      const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.slice(dataStart, dataStart + compressedSize);
      entries[fileName] = inflateZipEntry(compressed, method);
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function inflateZipEntry(compressed, method) {
  if (method === 0) return compressed;
  if (method === 8) return zlib.inflateRawSync(compressed);
  throw new Error(`Unsupported ZIP compression method ${method}`);
}

function parseSharedStrings(buffer) {
  if (!buffer) return [];
  const strings = [];
  const regex = /<si\b[\s\S]*?<\/si>/g;
  const xml = buffer.toString("utf8");
  let match;
  while ((match = regex.exec(xml))) strings.push(cleanText(extractXmlTexts(match[0], "t").join(" ")));
  return strings;
}

function parseWorkbookSheets(zip) {
  const workbook = zip["xl/workbook.xml"] ? zip["xl/workbook.xml"].toString("utf8") : "";
  const rels = zip["xl/_rels/workbook.xml.rels"] ? zip["xl/_rels/workbook.xml.rels"].toString("utf8") : "";
  const relMap = new Map();
  const relRegex = /<Relationship\b([^>]*?)\/>/g;
  let relMatch;
  while ((relMatch = relRegex.exec(rels))) {
    const id = attr(relMatch[1], "Id");
    let target = attr(relMatch[1], "Target");
    if (id && target) {
      target = target.replace(/^\//, "");
      if (!target.startsWith("xl/")) target = `xl/${target}`;
      relMap.set(id, target.replace(/\\/g, "/"));
    }
  }

  const sheets = new Map();
  const sheetRegex = /<sheet\b([^>]*?)\/>/g;
  let sheetMatch;
  while ((sheetMatch = sheetRegex.exec(workbook))) {
    const name = decodeXml(attr(sheetMatch[1], "name") || "");
    const relId = attr(sheetMatch[1], "r:id");
    const target = relMap.get(relId);
    if (name && target) sheets.set(target, name);
  }
  return sheets;
}

function extractXmlTexts(xml, tagName) {
  const escaped = tagName.replace(":", "\\:");
  const regex = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "g");
  const values = [];
  let match;
  while ((match = regex.exec(xml))) values.push(decodeXml(match[1]));
  return values;
}

function attr(source, name) {
  const escaped = name.replace(":", "\\:");
  const match = source.match(new RegExp(`\\b${escaped}=["']([^"']*)["']`, "i"));
  return match ? match[1] : "";
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function decodePdfStream(rawStream, dict) {
  if (!/FlateDecode/i.test(dict)) return rawStream;
  try {
    return zlib.inflateSync(rawStream);
  } catch {
    try {
      return zlib.inflateRawSync(rawStream);
    } catch {
      return null;
    }
  }
}

function extractPdfTextOperators(buffer) {
  const content = buffer.toString("latin1");
  if (!/(BT|Tj|TJ|\s'|\s")/.test(content)) return "";
  return [...extractPdfLiteralStrings(content), ...extractPdfHexStrings(content)].join(" ");
}

function extractPdfLiteralStrings(content) {
  const out = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== "(") continue;
    let depth = 1;
    let escaped = false;
    let value = "";
    for (let j = i + 1; j < content.length; j++) {
      const char = content[j];
      if (escaped) {
        value += decodePdfEscape(char);
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      if (depth === 0) {
        i = j;
        break;
      }
      value += char;
    }
    const cleaned = cleanText(value);
    if (cleaned) out.push(cleaned);
  }
  return out;
}

function decodePdfEscape(char) {
  if (char === "n") return "\n";
  if (char === "r") return "\r";
  if (char === "t") return "\t";
  if (char === "b" || char === "f") return " ";
  return char;
}

function extractPdfHexStrings(content) {
  const out = [];
  const regex = /<([0-9a-fA-F\s]{4,})>/g;
  let match;
  while ((match = regex.exec(content))) {
    const hex = match[1].replace(/\s+/g, "");
    if (hex.length % 2 !== 0) continue;
    const bytes = Buffer.from(hex, "hex");
    let text = "";
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) text = swapUtf16(bytes.slice(2)).toString("utf16le");
    else text = bytes.toString("latin1");
    text = cleanText(text);
    if (text) out.push(text);
  }
  return out;
}

function extractPrintableText(buffer) {
  const latin = buffer.toString("latin1").match(/[A-Za-z0-9][A-Za-z0-9\s.,;:!?'"()/%&+\-]{4,}/g) || [];
  const utf16 = buffer.toString("utf16le").match(/[A-Za-z0-9][A-Za-z0-9\s.,;:!?'"()/%&+\-]{4,}/g) || [];
  return [...latin, ...utf16].map((part) => cleanText(part)).filter((part) => part.length > 4).join("\n");
}

function cleanText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\u0000/g, " ")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function likelyHumanText(text) {
  if (text.length < 3) return false;
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  return letters / Math.max(text.length, 1) > 0.25;
}

function repairPdfText(text) {
  let repaired = String(text || "").replace(/\ben-US\b/g, " ");
  for (const word of PDF_REPAIR_WORDS) {
    const pattern = word.split("").map(escapeRegex).join("\\s*");
    repaired = repaired.replace(new RegExp(`\\b${pattern}\\b`, "gi"), word);
  }
  return cleanText(repaired);
}

function buildQuery(query, modes) {
  const raw = cleanText(query);
  const tokens = tokenize(raw);
  const exactSet = new Set();
  const relatedSet = new Set();

  if (raw) {
    for (const part of raw.split(/[,;|]+/).map(cleanText).filter(Boolean)) exactSet.add(part);
    if (!exactSet.size) exactSet.add(raw);
  }

  const normalizedQuery = normalize(raw);
  for (const concept of CONCEPTS) {
    const matchesConcept = concept.keys.some((key) => conceptKeyMatchesSearch(key, normalizedQuery, tokens));
    if (matchesConcept) {
      for (const phrase of concept.related) relatedSet.add(phrase);
      for (const key of concept.keys) relatedSet.add(key);
    }
  }

  const semanticTokens = new Set(tokens);
  for (const phrase of relatedSet) {
    for (const token of tokenize(phrase)) semanticTokens.add(token);
  }

  return {
    raw,
    tokens,
    exactPhrases: modes.exact ? Array.from(exactSet).filter((phrase) => normalize(phrase).length > 1) : [],
    relatedPhrases: modes.related ? Array.from(relatedSet).filter((phrase) => normalize(phrase).length > 1) : [],
    semanticTokens: modes.semantic ? Array.from(semanticTokens) : [],
    fileTypes: modes.fileTypes || []
  };
}

function conceptKeyMatchesSearch(key, normalizedQuery, queryTokens) {
  const normalizedKey = normalize(key);
  const keyTokens = tokenize(key);
  if (normalizedQuery === normalizedKey) return true;
  if ((key.length <= 4 || keyTokens.length >= 2) && normalizedQuery.includes(normalizedKey)) return true;
  if (queryTokens.length <= 2) return keyTokens.some((token) => queryTokens.includes(token));
  return keyTokens.filter((token) => queryTokens.includes(token)).length >= Math.min(2, keyTokens.length);
}

function searchIndex(query, modes = {}) {
  const built = buildQuery(query, {
    exact: modes.exact !== false,
    related: modes.related !== false,
    semantic: modes.semantic !== false,
    fileTypes: Array.isArray(modes.fileTypes) ? modes.fileTypes : []
  });
  if (!built.raw) return { results: [], totalFiles: 0, totalSnippets: 0, query: built };

  const allowedTypes = new Set(built.fileTypes.map((type) => String(type).toUpperCase()).filter(Boolean));
  const results = [];

  for (const record of state.index.values()) {
    if (allowedTypes.size && !allowedTypes.has(record.extension)) continue;
    const snippets = [];
    const seenSnippetKeys = new Set();
    let score = 0;
    const candidateIndexes = candidateSectionIndexes(record, built);

    for (const index of candidateIndexes) {
      const section = record.sections[index];
      if (!section) continue;

      for (const hit of collectPhraseHits(section.text, built.exactPhrases, "Exact")) {
        addSnippet(snippets, seenSnippetKeys, section, hit);
        score += 10;
      }
      for (const hit of collectPhraseHits(section.text, built.relatedPhrases, "Related")) {
        addSnippet(snippets, seenSnippetKeys, section, hit);
        score += 6;
      }
      const semanticHit = modes.semantic !== false ? semanticSectionHit(section.text, built.tokens, built.semanticTokens, section.tokens) : null;
      if (semanticHit) {
        addSnippet(snippets, seenSnippetKeys, section, semanticHit);
        score += semanticHit.score;
      }
      if (snippets.length >= MAX_SNIPPETS_PER_FILE) break;
    }

    if (snippets.length) {
      results.push({
        id: record.id,
        fileName: record.fileName,
        path: record.path,
        folder: record.folder,
        category: record.category,
        extension: record.extension,
        size: record.size,
        modifiedAt: record.modifiedAt,
        matchType: strongestMatchType(snippets),
        score,
        snippets
      });
    }
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return new Date(b.modifiedAt) - new Date(a.modifiedAt);
  });

  return {
    results,
    totalFiles: results.length,
    totalSnippets: results.reduce((sum, result) => sum + result.snippets.length, 0),
    query: {
      exactPhrases: built.exactPhrases,
      relatedPhrases: built.relatedPhrases,
      semanticTokens: built.semanticTokens
    }
  };
}

function candidateSectionIndexes(record, built) {
  const tokens = new Set();
  for (const phrase of [...built.exactPhrases, ...built.relatedPhrases]) {
    for (const token of tokenize(phrase)) tokens.add(token);
  }
  for (const token of built.semanticTokens) tokens.add(token);
  const indexes = new Set();
  for (const token of tokens) {
    for (const index of record.termSections[token] || []) indexes.add(index);
  }
  return indexes.size ? Array.from(indexes) : record.sections.map((_section, index) => index);
}

function collectPhraseHits(text, phrases, type) {
  const hits = [];
  for (const phrase of phrases) {
    const regex = phraseRegex(phrase);
    if (!regex) continue;
    let match;
    while ((match = regex.exec(text))) {
      hits.push({ type, term: phrase, index: match.index, length: match[0].length, score: type === "Exact" ? 10 : 6 });
      if (match.index === regex.lastIndex) regex.lastIndex += 1;
      if (hits.length > 16) break;
    }
  }
  return hits;
}

function phraseRegex(phrase) {
  const tokens = normalize(phrase).match(/[a-z0-9]+/g);
  if (!tokens || !tokens.length) return null;
  const source = tokens.map((token) => escapeRegex(stem(token))).join("[\\W_]+");
  return new RegExp(`\\b${source}\\b`, "gi");
}

function semanticSectionHit(text, queryTokens, semanticTokens, sectionTokenList) {
  if (!semanticTokens.length) return null;
  const sectionTokens = new Set(sectionTokenList || tokenize(text));
  const strict = Array.from(new Set(queryTokens));
  const overlap = strict.filter((token) => sectionTokens.has(token)).length;
  const relatedOverlap = semanticTokens.filter((token) => sectionTokens.has(token));
  const required = strict.length <= 1 ? 2 : Math.min(2, strict.length);
  if (overlap >= required || relatedOverlap.length >= Math.max(3, required)) {
    return {
      type: "Concept",
      term: relatedOverlap.slice(0, 5).join(", "),
      index: firstTokenPosition(text, relatedOverlap),
      length: 1,
      score: 2 + overlap + relatedOverlap.length
    };
  }
  return null;
}

function firstTokenPosition(text, tokens) {
  let best = -1;
  for (const token of tokens) {
    const match = new RegExp(`\\b${escapeRegex(token)}\\b`, "i").exec(text);
    if (match && (best === -1 || match.index < best)) best = match.index;
  }
  return best >= 0 ? best : 0;
}

function addSnippet(snippets, seenSnippetKeys, section, hit) {
  if (snippets.length >= MAX_SNIPPETS_PER_FILE) return;
  const snippet = makeSnippet(section.text, hit.index, hit.length);
  const key = `${section.label}|${snippet}`;
  if (seenSnippetKeys.has(key)) return;
  seenSnippetKeys.add(key);
  snippets.push({
    location: section.label,
    matchType: hit.type,
    term: hit.term,
    text: snippet
  });
}

function makeSnippet(text, index, length) {
  const radius = 210;
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + Math.max(length, 1) + radius);
  let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = `... ${snippet}`;
  if (end < text.length) snippet = `${snippet} ...`;
  return snippet;
}

function strongestMatchType(snippets) {
  if (snippets.some((snippet) => snippet.matchType === "Exact")) return "Exact";
  if (snippets.some((snippet) => snippet.matchType === "Related")) return "Related";
  return "Concept";
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  return normalize(value)
    .split(" ")
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
    .map(stem)
    .filter(Boolean);
}

function stem(token) {
  if (token === "gtm") return token;
  if (token.length > 5 && token.endsWith("ing")) {
    const base = token.slice(0, -3);
    if (base.endsWith("ic")) return `${base}e`;
    if (base.length > 3 && base.at(-1) === base.at(-2)) return base.slice(0, -1);
    return base;
  }
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -1);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function statusPayload() {
  return {
    appDir: APP_DIR,
    rootPath: state.rootPath,
    scanning: state.scanning,
    currentFile: state.currentFile,
    currentFolder: state.currentFolder,
    scannedFiles: state.scannedFiles,
    indexedFiles: state.indexedFiles,
    failedFiles: state.failedFiles,
    skippedFiles: state.skippedFiles,
    totalFiles: state.index.size,
    totalBytes: state.totalBytes,
    typeCounts: state.typeCounts,
    supportedTypes: Array.from(SUPPORTED_EXTS).map((ext) => ext.slice(1).toUpperCase()).sort(),
    lastScanStarted: state.lastScanStarted,
    lastScanFinished: state.lastScanFinished,
    messages: state.messages,
    errors: state.errors
  };
}

async function handleApi(req, res, requestUrl) {
  if (req.method === "GET" && requestUrl.pathname === "/api/status") return sendJson(res, statusPayload());

  if (req.method === "POST" && requestUrl.pathname === "/api/scan") {
    enqueueScan("Manual refresh");
    return sendJson(res, statusPayload());
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/search") {
    const body = await readJson(req);
    return sendJson(res, searchIndex(body.query || "", {
      exact: body.exact !== false,
      related: body.related !== false,
      semantic: body.semantic !== false,
      fileTypes: body.fileTypes || []
    }));
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/open") {
    const record = findRecordById(requestUrl.searchParams.get("id"));
    if (!record) return sendJson(res, { ok: false, error: "File is not indexed yet" }, 404);
    openLocalPath(record.path);
    return sendJson(res, { ok: true, path: record.path });
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/reveal") {
    const record = findRecordById(requestUrl.searchParams.get("id"));
    if (!record) return sendJson(res, { ok: false, error: "File is not indexed yet" }, 404);
    revealLocalPath(record.path);
    return sendJson(res, { ok: true, path: record.path });
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/copy-path") {
    const record = findRecordById(requestUrl.searchParams.get("id"));
    if (!record) return sendJson(res, { ok: false, error: "File is not indexed yet" }, 404);
    copyPathToClipboard(record.path);
    return sendJson(res, { ok: true, path: record.path });
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/download") {
    const record = findRecordById(requestUrl.searchParams.get("id"));
    if (!record) return sendJson(res, { ok: false, error: "File is not indexed yet" }, 404);
    return sendFileDownload(res, record.path);
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/root") {
    revealLocalPath(state.rootPath);
    return sendJson(res, { ok: true });
  }

  sendJson(res, { error: "Not found" }, 404);
}

function findRecordById(id) {
  return Array.from(state.index.values()).find((record) => record.id === id);
}

function openLocalPath(filePath) {
  if (!fs.existsSync(filePath)) throw new Error("File is no longer available at this path");
  if (process.platform === "win32") {
    const child = childProcess.spawn("cmd.exe", ["/c", "start", "", filePath], {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    child.unref();
    return;
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const child = childProcess.spawn(opener, [filePath], { detached: true, stdio: "ignore" });
  child.unref();
}

function revealLocalPath(filePath) {
  if (!fs.existsSync(filePath)) throw new Error("File is no longer available at this path");
  if (process.platform === "win32") {
    const args = fs.statSync(filePath).isDirectory() ? [filePath] : ["/select,", filePath];
    const child = childProcess.spawn("explorer.exe", args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    child.unref();
    return;
  }
  openLocalPath(fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath));
}

function copyPathToClipboard(filePath) {
  if (!fs.existsSync(filePath)) throw new Error("File is no longer available at this path");
  if (process.platform !== "win32") return;
  childProcess.spawn("powershell.exe", ["-NoProfile", "-Command", "Set-Clipboard -Value $args[0]", filePath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  }).unref();
}

async function sendFileDownload(res, filePath) {
  if (!fs.existsSync(filePath)) return sendJson(res, { error: "File is no longer available at this path" }, 404);
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) return sendJson(res, { error: "This result is not a file" }, 400);
  const fileName = path.basename(filePath).replace(/"/g, "");
  res.writeHead(200, {
    "Content-Type": mimeType(filePath),
    "Content-Length": stat.size,
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Cache-Control": "no-store"
  });
  fs.createReadStream(filePath).pipe(res);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

async function serveStatic(res, requestUrl) {
  let filePath = requestUrl.pathname === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, decodeURIComponent(requestUrl.pathname));
  const publicRoot = path.resolve(PUBLIC_DIR);
  filePath = path.resolve(filePath);
  if (!isPathInside(filePath, publicRoot)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error("Not a file");
    res.writeHead(200, {
      "Content-Type": mimeType(filePath),
      "Content-Length": stat.size,
      "Cache-Control": "no-store"
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

async function main() {
  if (!state.rootPath || !(await existsDirectory(state.rootPath))) {
    throw new Error(`Search root was not found from ${APP_DIR}`);
  }

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    try {
      if (requestUrl.pathname.startsWith("/api/")) await handleApi(req, res, requestUrl);
      else await serveStatic(res, requestUrl);
    } catch (error) {
      pushError(error.message);
      sendJson(res, { error: error.message }, 500);
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`${APP_NAME} is running at http://${HOST}:${PORT}`);
    console.log(`Search scope: ${state.rootPath}`);
    enqueueScan("Startup scan");
  });
}

function runExtractionWorker() {
  try {
    if (!workerData || workerData.action !== "extract") throw new Error("Unknown worker task");
    const sections = extractSections(workerData.filePath, workerData.ext);
    parentPort.postMessage({ sections });
  } catch (error) {
    parentPort.postMessage({ error: error.message });
  }
}

async function existsDirectory(dirPath) {
  try {
    return (await fsp.stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

if (isMainThread) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  runExtractionWorker();
}
