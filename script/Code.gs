// =============================================
// mhr-cfw Code.gs - Optimized v1.5 (بهینه برای quota)
// CACHE + بهتر Batch + Cache Key هوشمند
// =============================================

const AUTH_KEY = "ramz_ro_bezar_inja";   // دقیقاً مثل config.json
const WORKER_URL = "id_worker_ro_bezar_inja";  // ورکر خودت

const CACHE_SECONDS = 420;        // ۷ دقیقه — مناسب برای تصاویر و json اینستاگرام
const MAX_BATCH_SIZE = 10;

const SKIP_HEADERS = {
  host: 1, connection: 1, "content-length": 1,
  "transfer-encoding": 1, "proxy-connection": 1, 
  "proxy-authorization": 1, "upgrade": 1
};

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (req.k !== AUTH_KEY) {
      return _json({ e: "unauthorized" });
    }

    if (Array.isArray(req.q)) {
      return _doBatch(req.q);
    }
    return _doSingle(req);

  } catch (err) {
    console.error("doPost error:", err);
    return _json({ e: String(err) });
  }
}

// ==================== SINGLE REQUEST ====================
function _doSingle(req) {
  if (!req.u || typeof req.u !== "string" || !req.u.match(/^https?:\/\//i)) {
    return _json({ e: "bad url" });
  }

  const method = (req.m || "GET").toUpperCase();
  const isCacheable = (method === "GET" && !req.b);

  // تلاش برای خواندن از کش
  if (isCacheable) {
    const cacheKey = _generateCacheKey(req);
    const cache = CacheService.getScriptCache();
    const cached = cache.get(cacheKey);
    if (cached) {
      try {
        return _json(JSON.parse(cached));
      } catch (e) {}
    }
  }

  const payload = _buildWorkerPayload(req);

  const resp = UrlFetchApp.fetch(WORKER_URL, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
    followRedirects: true
  });

  let result;
  try {
    result = JSON.parse(resp.getContentText());
  } catch (e) {
    result = { e: "invalid worker response", raw: resp.getContentText().substring(0, 500) };
  }

  // ذخیره در کش (فقط پاسخ‌های موفق و cacheable)
  if (isCacheable && !result.e) {
    try {
      const cache = CacheService.getScriptCache();
      const cacheKey = _generateCacheKey(req);
      cache.put(cacheKey, JSON.stringify(result), CACHE_SECONDS);
    } catch (e) {
      console.error("Cache put failed:", e);
    }
  }

  return _json(result);
}

// ==================== BATCH REQUEST ====================
function _doBatch(items) {
  const results = [];
  const fetchRequests = [];
  const cache = CacheService.getScriptCache();
  const errorMap = {};

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.u || typeof item.u !== "string" || !item.u.match(/^https?:\/\//i)) {
      errorMap[i] = "bad url";
      results[i] = { e: "bad url" };
      continue;
    }

    const method = (item.m || "GET").toUpperCase();
    const isCacheable = (method === "GET" && !item.b);

    if (isCacheable) {
      const cacheKey = _generateCacheKey(item);
      const cached = cache.get(cacheKey);
      if (cached) {
        try {
          results[i] = JSON.parse(cached);
          continue;
        } catch (e) {}
      }
    }

    const payload = _buildWorkerPayload(item);
    fetchRequests.push({
      index: i,
      payload: payload,
      isCacheable: isCacheable,
      cacheKey: isCacheable ? _generateCacheKey(item) : null
    });
  }

  // اجرای batch fetch
  if (fetchRequests.length > 0) {
    const fetchOptions = fetchRequests.map(f => ({
      url: WORKER_URL,
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(f.payload),
      muteHttpExceptions: true,
      followRedirects: true
    }));

    const responses = UrlFetchApp.fetchAll(fetchOptions);

    for (let j = 0; j < responses.length; j++) {
      const idx = fetchRequests[j].index;
      let result;
      try {
        result = JSON.parse(responses[j].getContentText());
      } catch (e) {
        result = { e: "invalid worker response" };
      }

      results[idx] = result;

      // کش کردن پاسخ موفق
      if (fetchRequests[j].isCacheable && !result.e) {
        try {
          cache.put(fetchRequests[j].cacheKey, JSON.stringify(result), CACHE_SECONDS);
        } catch (e) {}
      }
    }
  }

  return _json({ q: results });
}

// ==================== Helper Functions ====================
function _generateCacheKey(req) {
  // کش هوشمندتر: URL + مهم‌ترین هدرها
  let key = req.u + "|" + (req.m || "GET");
  if (req.h) {
    const importantHeaders = ['authorization', 'user-agent', 'accept', 'referer'];
    for (const h of importantHeaders) {
      if (req.h[h]) key += "|" + req.h[h];
    }
  }
  return Utilities.base64EncodeWebSafe(key);
}

function _buildWorkerPayload(req) {
  const headers = {};
  if (req.h && typeof req.h === "object") {
    for (const k in req.h) {
      if (req.h.hasOwnProperty(k) && !SKIP_HEADERS[k.toLowerCase()]) {
        headers[k] = req.h[k];
      }
    }
  }

  return {
    u: req.u,
    m: (req.m || "GET").toUpperCase(),
    h: headers,
    b: req.b || null,
    ct: req.ct || null,
    r: req.r !== false
  };
}

function doGet(e) {
  return HtmlService.createHtmlOutput("<h1>mhr-cfw Relay Active — v1.5 Optimized</h1><p>Cache + Batch enabled</p>");
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
