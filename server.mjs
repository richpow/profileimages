import express from "express";
import cors from "cors";
import axios from "axios";
import crypto from "crypto";
import { S3Client, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import pkg from "pg";

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// env
const {
  AWS_REGION,
  S3_BUCKET,
  S3_PREFIX = "profile-pictures",
  TOOL_TOKEN,
  CLOUDFRONT_DOMAIN,            // optional
  DATABASE_URL                  // Neon
} = process.env;

if (!AWS_REGION || !S3_BUCKET || !TOOL_TOKEN) {
  console.error("Missing required env AWS_REGION or S3_BUCKET or TOOL_TOKEN");
  process.exit(1);
}

const s3 = new S3Client({ region: AWS_REGION });
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;

// auth
function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token || token !== TOOL_TOKEN) return res.status(403).json({ ok: false, reason: "forbidden" });
  next();
}

// helpers
function cleanUser(u) {
  return String(u || "").trim().replace(/^@/, "");
}

function md5(buf) {
  return crypto.createHash("md5").update(buf).digest("hex");
}

async function fetchAvatarUrl(username) {
  const url = `https://www.tiktok.com/@${username}`;
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.8"
  };
  const patterns = [
    /"avatarLarger":"([^"]*(?:tiktokcdn|byteimg)[^"]+)"/,
    /"avatarThumb":"([^"]*(?:tiktokcdn|byteimg)[^"]+)"/,
    /"avatarMedium":"([^"]*(?:tiktokcdn|byteimg)[^"]+)"/,
    /"avatar":"([^"]*(?:tiktokcdn|byteimg)[^"]+)"/
  ];
  const resp = await axios.get(url, { timeout: 15000, headers });
  const html = resp.data || "";
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      const img = m[1].replace(/\\u002F/g, "/").replace(/\\/g, "");
      if (img.startsWith("http")) return img;
    }
  }
  // mobile fallback
  const mResp = await axios.get(url, {
    timeout: 15000,
    headers: { ...headers, "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1" }
  });
  const mHtml = mResp.data || "";
  for (const re of patterns) {
    const m = mHtml.match(re);
    if (m && m[1]) {
      const img = m[1].replace(/\\u002F/g, "/").replace(/\\/g, "");
      if (img.startsWith("http")) return img;
    }
  }
  return null;
}

async function downloadAndProcess(url) {
  const resp = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 15000,
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://www.tiktok.com/",
      "Accept": "image/webp,image/apng,image/*,*/*;q=0.8"
    }
  });
  const original = Buffer.from(resp.data);
  if (!original || original.length < 3000) return { ok: false, reason: "image too small" };

  try {
    const sharp = (await import("sharp")).default;
    const processed = await sharp(original).resize({ width: 400, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
    return { ok: true, buffer: processed, contentType: "image/jpeg" };
  } catch {
    return { ok: true, buffer: original, contentType: "image/jpeg" };
  }
}

async function headEtag(bucket, key) {
  try {
    const out = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return out.ETag ? out.ETag.replace(/"/g, "") : null;
  } catch {
    return null;
  }
}

async function putS3(bucket, key, body, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

function buildPublicUrl(key) {
  if (CLOUDFRONT_DOMAIN) return `https://${CLOUDFRONT_DOMAIN}/${key}`;
  return `s3://${S3_BUCKET}/${key}`;
}

// single refresh
app.post("/api/tools/avatar_refresh", auth, async (req, res) => {
  try {
    const username = cleanUser(req.body?.username);
    if (!username) return res.status(400).json({ ok: false, reason: "username required" });

    const key = `${S3_PREFIX}/${username}.jpg`;
    const avatarUrl = await fetchAvatarUrl(username);
    if (!avatarUrl) return res.status(502).json({ ok: false, reason: "avatar not found" });

    const got = await downloadAndProcess(avatarUrl);
    if (!got.ok) return res.status(502).json({ ok: false, reason: got.reason || "download failed" });

    const newMD5 = md5(got.buffer);
    const oldETag = await headEtag(S3_BUCKET, key);

    let updated = true;
    if (oldETag && oldETag === newMD5) {
      updated = false;
    } else {
      await putS3(S3_BUCKET, key, got.buffer, got.contentType);
    }

    return res.json({ ok: true, username, s3Key: key, url: buildPublicUrl(key), updated });
  } catch (e) {
    return res.status(500).json({ ok: false, reason: e.message || "error" });
  }
});

// batch refresh
app.post("/api/tools/avatar_refresh_batch", auth, async (req, res) => {
  const list = Array.isArray(req.body?.usernames) ? req.body.usernames.map(cleanUser).filter(Boolean) : [];
  if (!list.length) return res.status(400).json({ ok: false, reason: "usernames required" });

  const results = {};
  for (const u of list) {
    try {
      const key = `${S3_PREFIX}/${u}.jpg`;
      const avatarUrl = await fetchAvatarUrl(u);
      if (!avatarUrl) { results[u] = { ok: false, reason: "avatar not found" }; continue; }
      const got = await downloadAndProcess(avatarUrl);
      if (!got.ok) { results[u] = { ok: false, reason: got.reason || "download failed" }; continue; }
      const newMD5 = md5(got.buffer);
      const oldETag = await headEtag(S3_BUCKET, key);
      let updated = true;
      if (oldETag && oldETag === newMD5) {
        updated = false;
      } else {
        await putS3(S3_BUCKET, key, got.buffer, got.contentType);
      }
      results[u] = { ok: true, s3Key: key, url: buildPublicUrl(key), updated };
    } catch (e) {
      results[u] = { ok: false, reason: e.message || "error" };
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return res.json({ ok: true, results });
});

// user list from Neon
app.get("/api/tools/user_list", auth, async (req, res) => {
  if (!pool) return res.status(500).json({ ok: false, reason: "database not configured" });
  try {
    const { rows } = await pool.query(`select distinct username from users where username is not null and username <> '' order by 1`);
    const list = rows.map(r => cleanUser(r.username)).filter(Boolean);
    return res.json(list); // array for Scriptable
  } catch (e) {
    return res.status(500).json({ ok: false, reason: e.message || "db error" });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("avatar tool listening on " + port));
