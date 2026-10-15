/**
 * ============================================================================
 * MUSE AI IMAGE STUDIO - LOCAL BACKEND SERVER
 * Tự động hóa tạo ảnh chất lượng gốc từ Muse.ai bằng Cookie trình duyệt
 * ============================================================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

// Nạp playwright-core từ workspace hoặc cache
let chromium;
const pwCandidates = [
  'playwright-core',
  path.resolve(__dirname, '..', 'human-test', 'node_modules', 'playwright-core'),
  'playwright',
];
for (const candidate of pwCandidates) {
  try {
    chromium = require(candidate).chromium;
    if (chromium) break;
  } catch (_) {}
}
if (!chromium) {
  // Tìm trong npm-cache _npx nếu chưa có
  try {
    const npxDir = path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx');
    if (fs.existsSync(npxDir)) {
      for (const d of fs.readdirSync(npxDir)) {
        const p = path.join(npxDir, d, 'node_modules', 'playwright-core');
        if (fs.existsSync(p)) {
          chromium = require(p).chromium;
          break;
        }
      }
    }
  } catch (_) {}
}

const PORT = 3456;
const CONFIG_PATH = path.resolve(__dirname, 'config.json');
const OUTPUTS_DIR = path.resolve(__dirname, 'outputs');
const META_PATH = path.resolve(OUTPUTS_DIR, 'metadata.json');
const TEMP_DIR = path.resolve(__dirname, 'temp');
const PUBLIC_DIR = path.resolve(__dirname, 'public');

for (const dir of [OUTPUTS_DIR, TEMP_DIR, PUBLIC_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Đọc / ghi cấu hình
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (_) {}
  return { cookie: '', headless: true };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

// Đọc / ghi metadata lịch sử ảnh
function loadMetadata() {
  try {
    if (fs.existsSync(META_PATH)) {
      return JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
    }
  } catch (_) {}
  return [];
}

function saveMetadata(list) {
  fs.writeFileSync(META_PATH, JSON.stringify(list, null, 2), 'utf8');
}

// Làm sạch chuỗi Cookie hoặc bóc tách từ lệnh cURL (Bash / Windows CMD)
function extractCookieString(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return '';
  let text = rawInput.trim();

  // Nếu người dùng dán lệnh cURL từ Windows CMD (có ký tự ^ escape)
  if (text.includes('curl ') || text.includes('-b ') || text.includes('--cookie')) {
    // Khôi phục escape của CMD: ^% -> %, ^" -> ", ^\ -> \, ^^ -> ^
    text = text
      .replace(/\^%/g, '%')
      .replace(/\^\^/g, '^')
      .replace(/\^"/g, '"')
      .replace(/\^'/g, "'")
      .replace(/\^([&|<>(){}[\]])/g, '$1');

    const bMatch =
      text.match(/(?:-b|--cookie)\s+'([^']+)'/) ||
      text.match(/(?:-b|--cookie)\s+"([^"]+)"/) ||
      text.match(/-H\s+['"]cookie:\s*([^'"]+)['"]/i);
    if (bMatch && bMatch[1]) {
      return bMatch[1].trim();
    }
  }

  // Nếu người dùng dán "cookie: ..."
  text = text.replace(/^cookie:\s*/i, '').trim();
  return text;
}

// Chuyển chuỗi cookie sang mảng Playwright cookies
function parsePlaywrightCookies(cookieStr) {
  return cookieStr
    .split(';')
    .map(pair => {
      const idx = pair.indexOf('=');
      if (idx === -1) return null;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (!name) return null;
      const isHost = name.startsWith('__Host-');
      return isHost
        ? { name, value, url: 'https://muse.ai', secure: true, sameSite: 'Strict' }
        : { name, value, domain: 'muse.ai', path: '/', secure: true, sameSite: 'Lax' };
    })
    .filter(Boolean);
}

// Kiểm tra nhanh cookie qua /api/auth/check
async function verifyMuseCookie(cookieStr) {
  if (!cookieStr) return { ok: false, error: 'Chưa cấu hình Cookie' };
  try {
    const res = await fetch('https://muse.ai/api/auth/check', {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        'cookie': cookieStr,
        'origin': 'https://muse.ai',
        'referer': 'https://muse.ai/',
        'sec-ch-prefers-color-scheme': 'light',
        'sec-ch-ua': '"Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
      },
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    return {
      ok: Boolean(data && data.ok),
      viewerId: data.viewer_id || null,
      outcome: data.outcome || null,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ============================================================================
// QUẢN LÝ PHIÊN TRÌNH DUYỆT PLAYWRIGHT KẾT NỐI MUSE.AI
// ============================================================================
let browser = null;
let context = null;
let page = null;
let sessionState = {
  status: 'starting', // 'starting' | 'ready' | 'generating' | 'error'
  statusText: 'Đang khởi tạo kết nối tới Muse.ai...',
  viewerId: null,
  headless: true,
  lastError: null,
  currentPrompt: null,
};
let isGeneratingLock = false;

async function closeBrowserSession() {
  try {
    if (browser) await browser.close();
  } catch (_) {}
  browser = null;
  context = null;
  page = null;
}

// Trích xuất tất cả ảnh blob hiện có trên trang Muse.ai
async function extractPageBlobImages(activePage) {
  if (!activePage) return [];
  try {
    const rawItems = await activePage.evaluate(async () => {
      const imgs = Array.from(document.querySelectorAll('img')).filter(
        img =>
          img.src &&
          img.src.startsWith('blob:') &&
          img.complete &&
          (img.naturalWidth || img.width) >= 240 &&
          (img.naturalHeight || img.height) >= 240
      );
      const out = [];
      for (const img of imgs) {
        try {
          const res = await fetch(img.src);
          const blob = await res.blob();
          const reader = new FileReader();
          const dataUrl = await new Promise(resolve => {
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          });
          out.push({
            blobUrl: img.src,
            alt: img.alt || '',
            width: img.naturalWidth || img.width,
            height: img.naturalHeight || img.height,
            mime: blob.type || 'image/webp',
            base64: dataUrl.split(',')[1] || '',
          });
        } catch (_) {}
      }
      return out;
    });

    return rawItems
      .filter(item => item.base64)
      .map(item => {
        const buffer = Buffer.from(item.base64, 'base64');
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        return {
          ...item,
          buffer,
          sha256,
          size: buffer.length,
        };
      });
  } catch (err) {
    return [];
  }
}

// Lưu ảnh vào thư mục outputs/ nếu chưa tồn tại mã băm sha256
function saveImageToOutputs(imgObj, promptText = 'Ảnh đồng bộ từ phiên Muse.ai') {
  const metadata = loadMetadata();
  const existing = metadata.find(m => m.sha256 === imgObj.sha256);
  if (existing && fs.existsSync(path.join(OUTPUTS_DIR, existing.filename))) {
    return existing;
  }

  const ext = imgObj.mime.includes('png')
    ? 'png'
    : imgObj.mime.includes('jpeg') || imgObj.mime.includes('jpg')
    ? 'jpg'
    : 'webp';
  const filename = `muse_${Date.now()}_${imgObj.sha256.slice(0, 8)}.${ext}`;
  const filePath = path.join(OUTPUTS_DIR, filename);
  fs.writeFileSync(filePath, imgObj.buffer);

  const record = {
    id: imgObj.sha256.slice(0, 12),
    filename,
    url: `/outputs/${filename}`,
    prompt: promptText,
    width: imgObj.width,
    height: imgObj.height,
    mime: imgObj.mime,
    size: imgObj.size,
    sha256: imgObj.sha256,
    createdAt: new Date().toISOString(),
  };

  metadata.unshift(record);
  saveMetadata(metadata);
  return record;
}

// Khởi tạo hoặc khởi động lại phiên trình duyệt Muse.ai
async function initMuseSession() {
  const cfg = loadConfig();
  sessionState.headless = cfg.headless !== false;
  sessionState.status = 'starting';
  sessionState.statusText = 'Đang kiểm tra Cookie & kết nối Muse.ai...';
  sessionState.lastError = null;

  await closeBrowserSession();

  const authCheck = await verifyMuseCookie(cfg.cookie);
  if (!authCheck.ok) {
    sessionState.status = 'error';
    sessionState.statusText = 'Cookie hết hạn hoặc không hợp lệ. Vui lòng cập nhật Cookie.';
    sessionState.lastError = authCheck.error;
    return false;
  }
  sessionState.viewerId = authCheck.viewerId;

  try {
    sessionState.statusText = 'Đang mở trình duyệt kết nối WebSocket Noise tới Muse.ai...';
    browser = await chromium.launch({
      channel: 'chrome',
      headless: sessionState.headless,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
    });

    const cookies = parsePlaywrightCookies(cfg.cookie);
    await context.addCookies(cookies);

    page = await context.newPage();
    await page.goto('https://muse.ai/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Đợi ô nhập tin nhắn xuất hiện
    await page.waitForSelector('textarea[placeholder="Message"]', { timeout: 20000 });

    // Đợi thêm một chút để WebSocket Noise đồng bộ lịch sử chat
    try {
      await page.waitForSelector('img[src^="blob:"]', { timeout: 8000 });
    } catch (_) {}
    await page.waitForTimeout(1500);

    // Đồng bộ các ảnh có sẵn trong đoạn chat
    const existingImgs = await extractPageBlobImages(page);
    for (const img of existingImgs) {
      saveImageToOutputs(img, 'Ảnh đồng bộ từ lịch sử chat Muse.ai');
    }

    sessionState.status = 'ready';
    sessionState.statusText = `Đã kết nối Muse.ai (UID: ${sessionState.viewerId})`;
    console.log(`✅ [Muse Studio] Đã kết nối thành công! UID: ${sessionState.viewerId}`);
    return true;
  } catch (err) {
    console.error('❌ [Muse Studio] Lỗi khởi tạo phiên:', err.message);
    sessionState.status = 'error';
    sessionState.statusText = 'Lỗi kết nối trình duyệt: ' + err.message;
    sessionState.lastError = err.message;
    return false;
  }
}

// Hàm tạo ảnh chính từ Prompt (hỗ trợ cả đính kèm ảnh tham chiếu)
async function generateImageOnMuse({ prompt, aspectRatio, style, referenceImageBase64, referenceImageName }) {
  if (isGeneratingLock) {
    throw new Error('Hệ thống đang xử lý một yêu cầu tạo ảnh khác. Vui lòng đợi hoàn tất.');
  }

  isGeneratingLock = true;
  try {
    if (!page || sessionState.status === 'error') {
      const ok = await initMuseSession();
      if (!ok) throw new Error(sessionState.statusText || 'Không thể kết nối Muse.ai');
    }

    // Ghép câu lệnh đầy đủ theo style và tỷ lệ khung hình
    let finalPrompt = prompt.trim();
    const hasImageKeyword = /(create|generate|draw|paint|tạo ảnh|vẽ|hãy vẽ|tạo hình|chỉnh|sửa ảnh)/i.test(finalPrompt);
    if (!hasImageKeyword && !referenceImageBase64) {
      finalPrompt = `Create an image of: ${finalPrompt}`;
    }
    if (style && style !== 'default') {
      finalPrompt += `, ${style} style`;
    }
    if (aspectRatio && aspectRatio !== 'auto') {
      finalPrompt += `, aspect ratio ${aspectRatio}`;
    }

    sessionState.status = 'generating';
    sessionState.currentPrompt = prompt;
    sessionState.statusText = `Đang gửi lệnh: "${prompt.slice(0, 50)}..."`;

    // 1. Ghi nhận danh sách mã băm (SHA-256) của toàn bộ ảnh đang có trên trang trước khi gửi
    const initialImgs = await extractPageBlobImages(page);
    const knownHashes = new Set(initialImgs.map(i => i.sha256));

    // 2. Nếu có ảnh tham chiếu đính kèm, nạp vào input[type="file"]
    let tempFilePath = null;
    if (referenceImageBase64) {
      const cleanBase64 = referenceImageBase64.includes(',')
        ? referenceImageBase64.split(',')[1]
        : referenceImageBase64;
      const uploadBuf = Buffer.from(cleanBase64, 'base64');
      const uploadHash = crypto.createHash('sha256').update(uploadBuf).digest('hex');
      knownHashes.add(uploadHash);

      const safeName = (referenceImageName || 'reference.png').replace(/[^a-zA-Z0-9._-]/g, '_');
      tempFilePath = path.join(TEMP_DIR, `upload_${Date.now()}_${safeName}`);
      fs.writeFileSync(tempFilePath, uploadBuf);

      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(tempFilePath);
      await page.waitForTimeout(1500);

      // Ghi nhận thêm bất kỳ blob preview nào của ảnh vừa upload
      const afterUploadImgs = await extractPageBlobImages(page);
      for (const uImg of afterUploadImgs) {
        knownHashes.add(uImg.sha256);
      }
    }

    // 3. Nhập prompt vào ô chat và nhấn Enter
    const textarea = page.locator('textarea[placeholder="Message"]').first();
    await textarea.click();
    await textarea.fill(finalPrompt);
    await page.waitForTimeout(300);
    await textarea.press('Enter');

    // Nếu vừa gửi ảnh đính kèm, đợi 1.8 giây để bong bóng tin nhắn của user hiện ra và loại trừ ảnh của user
    await page.waitForTimeout(1800);
    if (referenceImageBase64) {
      const userBubbleImgs = await extractPageBlobImages(page);
      for (const uImg of userBubbleImgs) {
        knownHashes.add(uImg.sha256);
      }
    }

    sessionState.statusText = 'Muse.ai đang vẽ ảnh (thường mất 8 - 20 giây)...';

    // 4. Vòng lặp theo dõi ảnh mới xuất hiện
    const maxWaitMs = 95000;
    const startTime = Date.now();
    let idleConnectedCount = 0;

    while (Date.now() - startTime < maxWaitMs) {
      await page.waitForTimeout(1200);

      // Cuộn xuống cuối khung chat để đảm bảo ảnh mới được tải đầy đủ
      await page.evaluate(() => {
        const scrollers = Array.from(document.querySelectorAll('div')).filter(
          el => el.scrollHeight > el.clientHeight + 100
        );
        for (const el of scrollers) {
          el.scrollTop = el.scrollHeight;
        }
      });

      const currentImgs = await extractPageBlobImages(page);
      const newImgs = currentImgs.filter(img => !knownHashes.has(img.sha256) && img.width >= 300);

      if (newImgs.length > 0) {
        // Đợi thêm 1 giây để đảm bảo Muse đã nạp bản sắc nét nhất
        await page.waitForTimeout(1000);
        const finalCheckImgs = await extractPageBlobImages(page);
        const finalNewImgs = finalCheckImgs.filter(img => !knownHashes.has(img.sha256) && img.width >= 300);
        const picked = (finalNewImgs.length > 0 ? finalNewImgs : newImgs).pop();

        const savedRecord = saveImageToOutputs(picked, prompt);
        sessionState.status = 'ready';
        sessionState.currentPrompt = null;
        sessionState.statusText = `Đã tạo ảnh thành công (${savedRecord.width}x${savedRecord.height})!`;

        if (tempFilePath && fs.existsSync(tempFilePath)) {
          try { fs.unlinkSync(tempFilePath); } catch (_) {}
        }
        return { ok: true, image: savedRecord };
      }

      // Kiểm tra trạng thái bên phải của Muse xem đã dừng xử lý mà chỉ trả lời bằng chữ hay chưa
      const pageStatus = await page.evaluate(() => {
        const bodyText = document.body.innerText || '';
        const isGeneratingText = /(Generating image|Creating|Thinking|Rendering|Working)/i.test(bodyText);
        const isConnected = bodyText.includes('Connected');
        const lines = bodyText
          .split('\n')
          .map(l => l.trim())
          .filter(Boolean);
        return {
          isGeneratingText,
          isConnected,
          tailLines: lines.slice(-15),
        };
      });

      const elapsed = Date.now() - startTime;
      if (elapsed > 7000 && pageStatus.isConnected && !pageStatus.isGeneratingText) {
        idleConnectedCount++;
        if (idleConnectedCount >= 4) {
          // Kiểm tra lần cuối xem có ảnh nào vừa kịp hiện không
          const lastTryImgs = await extractPageBlobImages(page);
          const foundLast = lastTryImgs.filter(img => !knownHashes.has(img.sha256) && img.width >= 300);
          if (foundLast.length > 0) {
            const savedRecord = saveImageToOutputs(foundLast.pop(), prompt);
            sessionState.status = 'ready';
            sessionState.currentPrompt = null;
            sessionState.statusText = `Đã tạo ảnh thành công (${savedRecord.width}x${savedRecord.height})!`;
            return { ok: true, image: savedRecord };
          }

          // Nếu không có ảnh mới mà Muse đã về Connected, trả về câu trả lời văn bản của Muse
          const replyHint = pageStatus.tailLines.slice(0, 6).join(' | ');
          sessionState.status = 'ready';
          sessionState.currentPrompt = null;
          sessionState.statusText = 'Muse.ai đã phản hồi (không tạo ảnh cho câu lệnh này).';
          throw new Error(
            `Muse.ai từ chối hoặc chỉ trả lời bằng văn bản mà không vẽ ảnh. Hãy mô tả rõ hơn yêu cầu tạo ảnh mới. (Phản hồi: ${replyHint})`
          );
        }
      } else {
        idleConnectedCount = 0;
      }
    }

    throw new Error('Quá thời gian chờ (95 giây) nhưng chưa nhận được ảnh từ Muse.ai.');
  } finally {
    isGeneratingLock = false;
    if (sessionState.status === 'generating') {
      sessionState.status = 'ready';
      sessionState.currentPrompt = null;
      sessionState.statusText = `Đã kết nối Muse.ai (UID: ${sessionState.viewerId || 'Active'})`;
    }
  }
}

// ============================================================================
// HTTP SERVER & REST API
// ============================================================================
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 25 * 1024 * 1024) {
        reject(new Error('Payload quá lớn (tối đa 25MB)'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('JSON không hợp lệ'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // 1. GET /api/status
  if (pathname === '/api/status' && req.method === 'GET') {
    const metadata = loadMetadata();
    return sendJson(res, 200, {
      ...sessionState,
      totalImages: metadata.length,
    });
  }

  // 2. GET /api/images
  if (pathname === '/api/images' && req.method === 'GET') {
    const metadata = loadMetadata().filter(item =>
      fs.existsSync(path.join(OUTPUTS_DIR, item.filename))
    );
    return sendJson(res, 200, { images: metadata });
  }

  // 3. POST /api/cookie - Cập nhật Cookie hoặc dán lệnh cURL
  if (pathname === '/api/cookie' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const cookieStr = extractCookieString(body.cookieInput || '');
      if (!cookieStr) {
        return sendJson(res, 400, { ok: false, error: 'Không tìm thấy dữ liệu Cookie hợp lệ.' });
      }
      const check = await verifyMuseCookie(cookieStr);
      if (!check.ok) {
        return sendJson(res, 400, {
          ok: false,
          error: `Cookie không hợp lệ hoặc đã hết hạn (${check.error || 'Forbidden'}).`,
        });
      }

      const cfg = loadConfig();
      cfg.cookie = cookieStr;
      saveConfig(cfg);

      // Khởi tạo lại phiên trình duyệt ở nền
      initMuseSession();
      return sendJson(res, 200, {
        ok: true,
        viewerId: check.viewerId,
        message: `Cập nhật Cookie thành công! UID: ${check.viewerId}`,
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // 4. POST /api/generate - Tạo ảnh mới
  if (pathname === '/api/generate' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      if (!body.prompt || !body.prompt.trim()) {
        return sendJson(res, 400, { ok: false, error: 'Vui lòng nhập mô tả ảnh (Prompt).' });
      }
      const result = await generateImageOnMuse({
        prompt: body.prompt,
        aspectRatio: body.aspectRatio || 'auto',
        style: body.style || 'default',
        referenceImageBase64: body.referenceImageBase64 || null,
        referenceImageName: body.referenceImageName || null,
      });
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // 5. POST /api/sync-history - Đồng bộ ảnh có sẵn trong khung chat Muse.ai
  if (pathname === '/api/sync-history' && req.method === 'POST') {
    try {
      if (!page || sessionState.status === 'error') {
        await initMuseSession();
      }
      const imgs = await extractPageBlobImages(page);
      const saved = [];
      for (const img of imgs) {
        saved.push(saveImageToOutputs(img, 'Ảnh đồng bộ từ lịch sử chat Muse.ai'));
      }
      return sendJson(res, 200, { ok: true, count: saved.length, images: loadMetadata() });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // 6. POST /api/toggle-browser - Bật/tắt chế độ ẩn/hiện cửa sổ Chrome
  if (pathname === '/api/toggle-browser' && req.method === 'POST') {
    try {
      const cfg = loadConfig();
      cfg.headless = !cfg.headless;
      saveConfig(cfg);
      initMuseSession();
      return sendJson(res, 200, {
        ok: true,
        headless: cfg.headless,
        message: cfg.headless
          ? 'Đã chuyển sang chế độ Chạy Ngầm (Headless).'
          : 'Đang mở cửa sổ trình duyệt Chrome trực tiếp...',
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // 7. POST /api/open-folder - Mở thư mục chứa ảnh trên Windows Explorer
  if (pathname === '/api/open-folder' && req.method === 'POST') {
    exec(`explorer "${OUTPUTS_DIR}"`);
    return sendJson(res, 200, { ok: true });
  }

  // 8. DELETE /api/images/:filename - Xóa ảnh
  if (pathname.startsWith('/api/images/') && req.method === 'DELETE') {
    const filename = path.basename(decodeURIComponent(pathname.replace('/api/images/', '')));
    const filePath = path.join(OUTPUTS_DIR, filename);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
    const metadata = loadMetadata().filter(m => m.filename !== filename);
    saveMetadata(metadata);
    return sendJson(res, 200, { ok: true });
  }

  // 9. Phục vụ file ảnh trong /outputs/
  if (pathname.startsWith('/outputs/') && req.method === 'GET') {
    const filename = path.basename(decodeURIComponent(pathname.replace('/outputs/', '')));
    const filePath = path.join(OUTPUTS_DIR, filename);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filename).toLowerCase();
      const mime =
        ext === '.png'
          ? 'image/png'
          : ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : 'image/webp';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  // 10. Phục vụ giao diện Web Studio
  if (pathname === '/' || pathname === '/index.html') {
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(indexPath).pipe(res);
      return;
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('============================================================');
  console.log(`🎨 MUSE AI IMAGE STUDIO ĐANG CHẠY TẠI: http://localhost:${PORT}`);
  console.log(`📁 Thư mục lưu ảnh gốc: ${OUTPUTS_DIR}`);
  console.log('============================================================');
  initMuseSession();
});
