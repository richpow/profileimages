import express from "express";
import cors from "cors";
import axios from "axios";
import { createHash, randomUUID } from "crypto";
import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand
} from "@aws-sdk/client-s3";
import pkg from "pg";

const { Pool } = pkg;

/* ---------- env ---------- */

const {
  AWS_REGION,
  S3_BUCKET,
  S3_PREFIX = "profile-pictures",
  TOOL_TOKEN,
  CLOUDFRONT_DOMAIN,
  DATABASE_URL,
  PORT
} = process.env;

if (!AWS_REGION || !S3_BUCKET || !TOOL_TOKEN) {
  console.error(
    "Missing required env AWS_REGION, S3_BUCKET or TOOL_TOKEN"
  );
  process.exit(1);
}

/* ---------- clients ---------- */

const s3 = new S3Client({
  region: AWS_REGION
});

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    })
  : null;

/* ---------- app ---------- */

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

/* ---------- auth ---------- */

function auth(req, res, next) {
  const token = String(
    req.headers.authorization || ""
  ).replace(/^Bearer\s+/i, "");

  if (!token || token !== TOOL_TOKEN) {
    return res.status(403).json({
      ok: false,
      reason: "forbidden"
    });
  }

  next();
}

/* ---------- general helpers ---------- */

function cleanUser(username) {
  return String(username || "")
    .trim()
    .replace(/^@/, "");
}

function md5(buffer) {
  return createHash("md5")
    .update(buffer)
    .digest("hex");
}

function sleep(milliseconds) {
  return new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  });
}

/* ---------- database helpers ---------- */

async function getLatestFastTrackUsernames() {
  if (!pool) {
    throw new Error("database not configured");
  }

  /*
   * Find the latest Data period in fasttrack_daily, then retrieve
   * every distinct username present on that date.
   *
   * PostgreSQL identifiers containing spaces, capital letters and
   * apostrophes must be wrapped in double quotes.
   */
  const { rows } = await pool.query(`
    with latest_period as (
      select max("Data period") as data_period
      from public.fasttrack_daily
      where "Data period" is not null
    )
    select distinct
      trim("Creator's username") as username
    from public.fasttrack_daily
    cross join latest_period
    where "Data period" = latest_period.data_period
      and "Creator's username" is not null
      and trim("Creator's username") <> ''
    order by username
  `);

  return rows
    .map(row => cleanUser(row.username))
    .filter(Boolean);
}

async function getLatestFastTrackPeriod() {
  if (!pool) {
    throw new Error("database not configured");
  }

  const { rows } = await pool.query(`
    select max("Data period") as data_period
    from public.fasttrack_daily
    where "Data period" is not null
  `);

  return rows[0]?.data_period || null;
}

/* ---------- TikTok helpers ---------- */

async function fetchAvatarUrl(username) {
  const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(
    username
  )}`;

  const desktopHeaders = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/124.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9," +
      "image/webp,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.8"
  };

  const avatarPatterns = [
    /"avatarLarger":"([^"]*(?:tiktokcdn|byteimg)[^"]+)"/,
    /"avatarThumb":"([^"]*(?:tiktokcdn|byteimg)[^"]+)"/,
    /"avatarMedium":"([^"]*(?:tiktokcdn|byteimg)[^"]+)"/,
    /"avatar":"([^"]*(?:tiktokcdn|byteimg)[^"]+)"/
  ];

  function extractAvatar(html) {
    for (const pattern of avatarPatterns) {
      const match = html.match(pattern);

      if (!match?.[1]) {
        continue;
      }

      const imageUrl = match[1]
        .replace(/\\u002F/g, "/")
        .replace(/\\u0026/g, "&")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");

      if (imageUrl.startsWith("http")) {
        return imageUrl;
      }
    }

    return null;
  }

  try {
    const desktopResponse = await axios.get(profileUrl, {
      timeout: 15000,
      headers: desktopHeaders,
      responseType: "text",
      validateStatus: status => status >= 200 && status < 400
    });

    const desktopAvatar = extractAvatar(
      String(desktopResponse.data || "")
    );

    if (desktopAvatar) {
      return desktopAvatar;
    }
  } catch {
    // Continue to mobile fallback.
  }

  const mobileHeaders = {
    ...desktopHeaders,
    "User-Agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) " +
      "AppleWebKit/605.1.15 (KHTML, like Gecko) " +
      "Version/16.0 Mobile/15E148 Safari/604.1"
  };

  try {
    const mobileResponse = await axios.get(profileUrl, {
      timeout: 15000,
      headers: mobileHeaders,
      responseType: "text",
      validateStatus: status => status >= 200 && status < 400
    });

    return extractAvatar(
      String(mobileResponse.data || "")
    );
  } catch {
    return null;
  }
}

/* ---------- image helpers ---------- */

async function downloadAndProcess(url) {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 15000,
    maxContentLength: 10 * 1024 * 1024,
    maxBodyLength: 10 * 1024 * 1024,
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://www.tiktok.com/",
      Accept: "image/webp,image/apng,image/*,*/*;q=0.8"
    },
    validateStatus: status => status >= 200 && status < 300
  });

  const original = Buffer.from(response.data);

  if (!original || original.length < 3000) {
    return {
      ok: false,
      reason: "image too small"
    };
  }

  try {
    const sharp = (await import("sharp")).default;

    const processed = await sharp(original)
      .rotate()
      .resize({
        width: 400,
        height: 400,
        fit: "cover",
        position: "centre",
        withoutEnlargement: false
      })
      .jpeg({
        quality: 70,
        mozjpeg: true
      })
      .toBuffer();

    return {
      ok: true,
      buffer: processed,
      contentType: "image/jpeg"
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error
          ? `image processing failed: ${error.message}`
          : "image processing failed"
    };
  }
}

/* ---------- S3 helpers ---------- */

async function headEtag(bucket, key) {
  try {
    const output = await s3.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key
      })
    );

    return output.ETag
      ? output.ETag.replace(/"/g, "")
      : null;
  } catch {
    return null;
  }
}

async function putS3(
  bucket,
  key,
  body,
  contentType
) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "public, max-age=86400"
    })
  );
}

function buildPublicUrl(key) {
  if (CLOUDFRONT_DOMAIN) {
    const domain = CLOUDFRONT_DOMAIN
      .replace(/^https?:\/\//i, "")
      .replace(/\/+$/, "");

    return `https://${domain}/${key}`;
  }

  return `s3://${S3_BUCKET}/${key}`;
}

/* ---------- avatar refresh helper ---------- */

async function refreshAvatar(username) {
  const cleanedUsername = cleanUser(username);

  if (!cleanedUsername) {
    return {
      ok: false,
      reason: "username required"
    };
  }

  const key = `${S3_PREFIX}/${cleanedUsername}.jpg`;

  const avatarUrl = await fetchAvatarUrl(
    cleanedUsername
  );

  if (!avatarUrl) {
    return {
      ok: false,
      username: cleanedUsername,
      reason: "avatar not found"
    };
  }

  const downloaded = await downloadAndProcess(
    avatarUrl
  );

  if (!downloaded.ok) {
    return {
      ok: false,
      username: cleanedUsername,
      reason:
        downloaded.reason || "download failed"
    };
  }

  const newMD5 = md5(downloaded.buffer);
  const oldETag = await headEtag(
    S3_BUCKET,
    key
  );

  let updated = true;

  if (oldETag && oldETag === newMD5) {
    updated = false;
  } else {
    await putS3(
      S3_BUCKET,
      key,
      downloaded.buffer,
      downloaded.contentType
    );
  }

  return {
    ok: true,
    username: cleanedUsername,
    s3Key: key,
    url: buildPublicUrl(key),
    updated
  };
}

/* ---------- job storage ---------- */

const jobs = new Map();

/*
Job shape:

{
  total,
  processed,
  completed,
  updated,
  unchanged,
  failed,
  currentPeriod,
  startedAt,
  finishedAt,
  errors
}
*/

function updateJob(jobId, updater) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  updater(job);
  jobs.set(jobId, job);
}

/* ---------- routes ---------- */

app.get("/health", async (_req, res) => {
  return res.json({
    ok: true
  });
});

/*
 * Return the latest FastTrack data period and the exact usernames
 * that would be processed.
 */
app.get(
  "/api/tools/user_list",
  auth,
  async (_req, res) => {
    try {
      const [usernames, dataPeriod] =
        await Promise.all([
          getLatestFastTrackUsernames(),
          getLatestFastTrackPeriod()
        ]);

      return res.json({
        ok: true,
        data_period: dataPeriod,
        total: usernames.length,
        usernames
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        reason:
          error instanceof Error
            ? error.message
            : "database error"
      });
    }
  }
);

/*
 * Refresh one specific username supplied in the request body.
 */
app.post(
  "/api/tools/avatar_refresh",
  auth,
  async (req, res) => {
    try {
      const username = cleanUser(
        req.body?.username
      );

      if (!username) {
        return res.status(400).json({
          ok: false,
          reason: "username required"
        });
      }

      const result = await refreshAvatar(
        username
      );

      if (!result.ok) {
        return res.status(502).json(result);
      }

      return res.json(result);
    } catch (error) {
      return res.status(500).json({
        ok: false,
        reason:
          error instanceof Error
            ? error.message
            : "error"
      });
    }
  }
);

/*
 * Refresh an explicitly supplied batch of usernames.
 */
app.post(
  "/api/tools/avatar_refresh_batch",
  auth,
  async (req, res) => {
    const supplied = Array.isArray(
      req.body?.usernames
    )
      ? req.body.usernames
      : [];

    const usernames = [
      ...new Set(
        supplied
          .map(cleanUser)
          .filter(Boolean)
      )
    ];

    if (!usernames.length) {
      return res.status(400).json({
        ok: false,
        reason: "usernames required"
      });
    }

    const results = {};

    for (const username of usernames) {
      try {
        results[username] =
          await refreshAvatar(username);
      } catch (error) {
        results[username] = {
          ok: false,
          reason:
            error instanceof Error
              ? error.message
              : "error"
        };
      }

      await sleep(200);
    }

    const summary = Object.values(
      results
    ).reduce(
      (output, result) => {
        output.processed++;

        if (!result.ok) {
          output.failed++;
        } else if (result.updated) {
          output.updated++;
        } else {
          output.unchanged++;
        }

        return output;
      },
      {
        processed: 0,
        updated: 0,
        unchanged: 0,
        failed: 0
      }
    );

    return res.json({
      ok: true,
      total: usernames.length,
      ...summary,
      results
    });
  }
);

/*
 * Start a background refresh for every distinct username on the
 * latest Data period in fasttrack_daily.
 */
app.post(
  "/api/tools/avatar_refresh_start",
  auth,
  async (_req, res) => {
    try {
      const [usernames, dataPeriod] =
        await Promise.all([
          getLatestFastTrackUsernames(),
          getLatestFastTrackPeriod()
        ]);

      if (!dataPeriod) {
        return res.status(404).json({
          ok: false,
          reason:
            "no Data period found in fasttrack_daily"
        });
      }

      if (!usernames.length) {
        return res.status(404).json({
          ok: false,
          reason:
            "no usernames found for the latest Data period",
          data_period: dataPeriod
        });
      }

      const jobId = randomUUID();

      jobs.set(jobId, {
        total: usernames.length,
        processed: 0,
        completed: 0,
        updated: 0,
        unchanged: 0,
        failed: 0,
        currentPeriod: dataPeriod,
        startedAt: Date.now(),
        finishedAt: null,
        errors: []
      });

      const concurrency = 4;
      const queue = [...usernames];

      void (async function runJob() {
        async function worker() {
          while (queue.length > 0) {
            const username = queue.shift();

            if (!username) {
              continue;
            }

            try {
              const result =
                await refreshAvatar(username);

              updateJob(jobId, job => {
                job.processed++;
                job.completed++;

                if (!result.ok) {
                  job.failed++;

                  if (
                    job.errors.length < 100
                  ) {
                    job.errors.push({
                      username,
                      reason:
                        result.reason ||
                        "refresh failed"
                    });
                  }
                } else if (result.updated) {
                  job.updated++;
                } else {
                  job.unchanged++;
                }
              });
            } catch (error) {
              updateJob(jobId, job => {
                job.processed++;
                job.completed++;
                job.failed++;

                if (
                  job.errors.length < 100
                ) {
                  job.errors.push({
                    username,
                    reason:
                      error instanceof Error
                        ? error.message
                        : "error"
                  });
                }
              });
            }

            await sleep(150);
          }
        }

        try {
          await Promise.all(
            Array.from(
              { length: concurrency },
              () => worker()
            )
          );
        } finally {
          updateJob(jobId, job => {
            job.finishedAt = Date.now();
          });
        }
      })();

      return res.json({
        ok: true,
        job_id: jobId,
        data_period: dataPeriod,
        total: usernames.length
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        reason:
          error instanceof Error
            ? error.message
            : "error"
      });
    }
  }
);

/*
 * Return the progress of a background refresh.
 */
app.get(
  "/api/tools/avatar_refresh_status",
  auth,
  async (req, res) => {
    const jobId = String(
      req.query.job_id || ""
    );

    const job = jobs.get(jobId);

    if (!job) {
      return res.status(404).json({
        ok: false,
        reason: "job not found"
      });
    }

    const finished =
      job.finishedAt !== null;

    return res.json({
      ok: true,
      job_id: jobId,
      status: finished
        ? "finished"
        : "running",
      progress:
        job.total > 0
          ? Math.round(
              (job.processed / job.total) *
                100
            )
          : 100,
      ...job
    });
  }
);

/* ---------- start ---------- */

const port = Number(PORT) || 8080;

app.listen(port, () => {
  console.log(
    `avatar tool listening on ${port}`
  );
});
