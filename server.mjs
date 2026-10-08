import express from "express";
import axios from "axios";
import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import pg from "pg";

// Use each region's OWN latest dated roster,
// then deduplicate usernames across both regions.
export const LATEST_ROSTER_SQL = `
WITH roster AS (
  SELECT lower(regexp_replace(trim("Creator's username"), '^@', '')) AS username,
         'UKI' AS region, "Data period"::text AS period
    FROM public.fasttrack_daily
   WHERE "Data period" = (
     SELECT max("Data period") FROM public.fasttrack_daily
   )

  UNION ALL

  SELECT lower(regexp_replace(trim("Creator's username"), '^@', '')) AS username,
         'MENA' AS region, "Data period"::text AS period
    FROM public.fasttrack_mena
   WHERE "Data period" = (
     SELECT max("Data period") FROM public.fasttrack_mena
   )
)
SELECT DISTINCT username, region, period
FROM roster
WHERE username ~ '^[a-z0-9._]{1,64}$'
ORDER BY username, region, period
`;

export function cleanUser(value) {
  const username = String(value ?? "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();

  if (!/^[a-z0-9._]{1,64}$/.test(username)) {
    throw new Error("Invalid TikTok username");
  }

  return username;
}

const digest = (buffer) =>
  createHash("sha256").update(buffer).digest("hex");

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const htmlHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-GB,en;q=0.8",
};

function avatarFromUser(user, username) {
  if (
    !user ||
    cleanUser(user.uniqueId ?? user.unique_id ?? "") !== username
  ) {
    return null;
  }

  return (
    user.avatarLarger ??
    user.avatarMedium ??
    user.avatarThumb ??
    user.avatar_url ??
    null
  );
}

export function extractAvatar(html, username) {
  // Only accept the requested creator's real photo.
  for (const id of [
    "__UNIVERSAL_DATA_FOR_REHYDRATION__",
    "SIGI_STATE",
  ]) {
    const script = html.match(
      new RegExp(
        `<script\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)<\\/script>`,
        "i",
      ),
    );

    if (!script) continue;

    try {
      const data = JSON.parse(script[1]);

      if (id === "__UNIVERSAL_DATA_FOR_REHYDRATION__") {
        const avatar = avatarFromUser(
          data.__DEFAULT_SCOPE__?.["webapp.user-detail"]
            ?.userInfo?.user,
          username,
        );

        if (avatar) return avatar;
      } else {
        for (const user of Object.values(
          data.UserModule?.users ?? {},
        )) {
          try {
            const avatar = avatarFromUser(user, username);
            if (avatar) return avatar;
          } catch {}
        }
      }
    } catch {}
  }

  // Compatibility with older flat user objects.
  for (const match of html.matchAll(
    /\{[^{}]*"uniqueId"\s*:\s*"[^"]+"[^{}]*\}/g,
  )) {
    try {
      const avatar = avatarFromUser(
        JSON.parse(match[0]),
        username,
      );

      if (avatar) return avatar;
    } catch {}
  }

  return null;
}

export function trustedAvatarUrl(value) {
  const url = new URL(value);

  const allowedHosts = [
    "tiktokcdn.com",
    "tiktokcdn-us.com",
    "tiktokcdn-eu.com",
    "byteimg.com",
  ];

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !allowedHosts.some(
      (host) =>
        url.hostname === host ||
        url.hostname.endsWith(`.${host}`),
    )
  ) {
    throw new Error("Untrusted TikTok avatar URL");
  }

  return url.href;
}

function integer(env, name, fallback, min, max) {
  const value = Number(env[name] ?? fallback);

  if (
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`Invalid ${name}`);
  }

  return value;
}

export function createAvatarTool({
  env = process.env,
  database,
  s3Client,
  get = axios.get,
  encode = sharp,
  wait = sleep,
  now = Date.now,
  log = console.log,
} = {}) {
  for (const name of [
    "AWS_REGION",
    "S3_BUCKET",
    "TOOL_TOKEN",
  ]) {
    if (!env[name]) {
      throw new Error(`Missing required ${name}`);
    }
  }

  const pool =
    database ??
    (env.DATABASE_URL
      ? new pg.Pool({
          connectionString: env.DATABASE_URL,
          max: 2,
          connectionTimeoutMillis: 10_000,
          query_timeout: 20_000,
          statement_timeout: 20_000,
        })
      : null);

  const s3 =
    s3Client ??
    new S3Client({
      region: env.AWS_REGION,
      maxAttempts: 3,
    });

  const prefix = (
    env.S3_PREFIX ?? "profile-pictures"
  ).replace(/^\/+|\/+$/g, "");

  const concurrency = integer(
    env,
    "REFRESH_CONCURRENCY",
    2,
    1,
    4,
  );

  const attempts = integer(
    env,
    "REFRESH_ATTEMPTS",
    3,
    1,
    5,
  );

  const requestDelay = integer(
    env,
    "REQUEST_DELAY_MS",
    500,
    0,
    60_000,
  );

  const pollMs =
    integer(
      env,
      "ROSTER_POLL_SECONDS",
      300,
      10,
      86_400,
    ) * 1_000;

  const fullInterval =
    integer(
      env,
      "REFRESH_INTERVAL_MINUTES",
      360,
      1,
      10_080,
    ) * 60_000;

  const automatic = env.AUTO_REFRESH !== "false";

  const jobs = new Map();

  // Internal queue metadata is deliberately excluded
  // from the public job-status JSON.
  const jobWork = new WeakMap();

  const failedUsers = new Set();
  const seenRoster = new Set();
  const inFlight = new Map();
  const waiting = [];

  let activeJob = null;
  let latestSignature = null;
  let lastFullStarted = null;
  let timer = null;
  let stopping = false;
  let checking = false;
  let running = 0;

  const app = express();

  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type",
    );
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS",
    );

    // Do not cache old progress counters or start acknowledgments.
    res.setHeader("Cache-Control", "no-store");

    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }

    next();
  });

  app.use(express.json({ limit: "1mb" }));

  const auth = (req, res, next) => {
    const token = String(
      req.headers.authorization ?? "",
    ).replace(/^Bearer\s+/i, "");

    if (!token || token !== env.TOOL_TOKEN) {
      return res.status(403).json({
        ok: false,
        reason: "forbidden",
      });
    }

    next();
  };

  async function roster() {
    if (!pool) {
      throw new Error("Database not configured");
    }

    const { rows } = await pool.query(
      LATEST_ROSTER_SQL,
    );

    return {
      usernames: [
        ...new Set(
          rows.map((row) => cleanUser(row.username)),
        ),
      ],

      signature: digest(JSON.stringify(rows)),

      periodSignature: digest(
        JSON.stringify(
          [
            ...new Set(
              rows.map(
                (row) =>
                  `${row.region}:${row.period}`,
              ),
            ),
          ].sort(),
        ),
      ),
    };
  }

  async function fetchAvatar(username) {
    const agents = [
      htmlHeaders["User-Agent"],
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Version/16.0 Mobile/15E148 Safari/604.1",
    ];

    for (const agent of agents) {
      try {
        const response = await get(
          `https://www.tiktok.com/@${encodeURIComponent(username)}`,
          {
            timeout: 15_000,
            maxRedirects: 0,
            maxContentLength: 5 * 1024 * 1024,
            headers: {
              ...htmlHeaders,
              "User-Agent": agent,
            },
          },
        );

        const avatar = extractAvatar(
          String(response.data ?? ""),
          username,
        );

        if (avatar) {
          return trustedAvatarUrl(avatar);
        }
      } catch {
        // Independently try mobile even when desktop fails.
      }
    }

    throw new Error(
      "TikTok profile photo unavailable",
    );
  }

  async function refreshAttempt(username) {
    const url = await fetchAvatar(username);

    const response = await get(url, {
      responseType: "arraybuffer",
      timeout: 15_000,
      maxRedirects: 0,
      maxContentLength: 10 * 1024 * 1024,
      headers: {
        Accept: "image/*",
        Referer: "https://www.tiktok.com/",
        "User-Agent": htmlHeaders["User-Agent"],
      },
    });

    if (
      !String(
        response.headers?.["content-type"] ?? "",
      )
        .toLowerCase()
        .startsWith("image/")
    ) {
      throw new Error(
        "TikTok returned a non-image response",
      );
    }

    // Decode and validate BEFORE changing S3.
    // Never replace a real photo with invalid bytes or a placeholder.
    const buffer = await encode(
      Buffer.from(response.data),
      {
        failOn: "error",
        limitInputPixels: 40_000_000,
      },
    )
      .rotate()
      .resize({
        width: 400,
        withoutEnlargement: true,
      })
      .jpeg({ quality: 70 })
      .toBuffer();

    const key = `${prefix}/${username}.jpg`;
    const hash = digest(buffer);

    let existing = null;

    try {
      existing = await s3.send(
        new HeadObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: key,
        }),
      );
    } catch (error) {
      if (
        error.$metadata?.httpStatusCode !== 404 &&
        !["NotFound", "NoSuchKey"].includes(
          error.name,
        )
      ) {
        throw new Error(
          "Cannot check existing S3 photo",
        );
      }
    }

    let updated =
      existing?.Metadata?.["avatar-sha256"] !==
      hash;

    // Older objects may not have SHA-256 metadata.
    // A simple MD5 ETag can identify unchanged bytes.
    if (
      updated &&
      existing?.ETag?.replaceAll('"', "") ===
        createHash("md5")
          .update(buffer)
          .digest("hex")
    ) {
      updated = false;
    }

    if (updated) {
      await s3.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: key,
          Body: buffer,
          ContentType: "image/jpeg",
          CacheControl: "public, max-age=300",
          Metadata: {
            "avatar-sha256": hash,
          },
          ChecksumSHA256: Buffer.from(
            hash,
            "hex",
          ).toString("base64"),
        }),
      );

      const saved = await s3.send(
        new HeadObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: key,
        }),
      );

      if (
        saved.Metadata?.["avatar-sha256"] !==
          hash ||
        saved.ContentLength !== buffer.length
      ) {
        throw new Error(
          "S3 upload verification failed",
        );
      }
    }

    const domain = env.CLOUDFRONT_DOMAIN
      ?.replace(/^https?:\/\//, "")
      .replace(/\/+$/, "");

    return {
      ok: true,
      username,
      s3Key: key,
      updated,
      url: domain
        ? `https://${domain}/${key}`
        : `https://${env.S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${key}`,
    };
  }

  function refreshOne(input) {
    const username = cleanUser(input);

    if (inFlight.has(username)) {
      return inFlight.get(username);
    }

    const promise = (async () => {
      if (running >= concurrency) {
        await new Promise((resolve) =>
          waiting.push(resolve),
        );
      } else {
        running++;
      }

      try {
        for (
          let attempt = 1;
          attempt <= attempts;
          attempt++
        ) {
          try {
            await wait(requestDelay);

            const result =
              await refreshAttempt(username);

            failedUsers.delete(username);
            return result;
          } catch {
            if (attempt === attempts) {
              failedUsers.add(username);

              return {
                ok: false,
                username,
                reason:
                  "Photo refresh failed; no placeholder image uploaded",
                attempts,
              };
            }

            await wait(
              Math.min(
                30_000,
                1_000 * 2 ** (attempt - 1),
              ),
            );
          }
        }
      } finally {
        if (waiting.length) {
          waiting.shift()();
        } else {
          running--;
        }
      }
    })().finally(() =>
      inFlight.delete(username),
    );

    inFlight.set(username, promise);
    return promise;
  }

  function launchJob(usernames, source) {
    const names = [
      ...new Set(usernames.map(cleanUser)),
    ];

    if (activeJob) {
      // A manual full refresh MUST NOT inherit only
      // an 81-person retry or late-arrival list.
      //
      // Expand the active job to cover every current
      // roster username without repeating anyone
      // already queued, running or completed.
      const work = jobWork.get(activeJob);
      let added = 0;

      for (const username of names) {
        if (work.usernames.has(username)) {
          continue;
        }

        work.usernames.add(username);
        work.queue.push(username);
        added++;
      }

      activeJob.total = work.usernames.size;

      if (
        source === "latest-rosters" &&
        activeJob.source ===
          "late-arrivals-or-retry"
      ) {
        activeJob.source = source;
      }

      log(
        `Avatar job expanded: ${added} added, ${activeJob.total} total`,
      );

      return {
        job: activeJob,
        coalesced: true,
      };
    }

    const job = {
      job_id: randomUUID(),
      source,
      total: names.length,
      completed: 0,
      updated: 0,
      unchanged: 0,
      failed: 0,
      startedAt: now(),
      finishedAt: null,
      failures: [],
    };

    const queue = [...names];

    jobWork.set(job, {
      queue,
      usernames: new Set(names),
    });

    jobs.set(job.job_id, job);

    while (jobs.size > 100) {
      jobs.delete(
        jobs.keys().next().value,
      );
    }

    activeJob = job;

    job.promise = (async () => {
      // Recheck after workers settle. A manual request
      // may append the full roster while a smaller
      // background batch is finishing.
      do {
        await Promise.all(
          Array.from(
            { length: concurrency },
            async () => {
              while (
                queue.length &&
                !stopping
              ) {
                const result =
                  await refreshOne(
                    queue.shift(),
                  );

                // Completed means attempted.
                // Updated, unchanged and failed remain separate.
                job.completed++;

                if (!result.ok) {
                  job.failed++;
                  job.failures.push(
                    result.username,
                  );
                } else if (
                  result.updated
                ) {
                  job.updated++;
                } else {
                  job.unchanged++;
                }
              }
            },
          ),
        );
      } while (
        queue.length &&
        !stopping
      );

      job.finishedAt = now();
      activeJob = null;

      log(
        `Avatar job finished: ${job.completed}/${job.total}, ${job.updated} updated, ${job.unchanged} unchanged, ${job.failed} failed`,
      );
    })();

    return {
      job,
      coalesced: false,
    };
  }

  async function startLatestJob() {
    if (stopping) {
      throw new Error("Service is stopping");
    }

    // IMPORTANT:
    // Always read the FULL latest UKI + MENA roster
    // BEFORE considering an existing active job.
    //
    // Do not return a small automatic retry job
    // without first adding the rest of the roster.
    const current = await roster();

    if (stopping) {
      throw new Error("Service is stopping");
    }

    if (!current.usernames.length) {
      throw new Error(
        "Latest regional rosters are empty",
      );
    }

    latestSignature =
      current.periodSignature;

    seenRoster.clear();

    current.usernames.forEach(
      (username) =>
        seenRoster.add(username),
    );

    lastFullStarted = now();

    return launchJob(
      current.usernames,
      "latest-rosters",
    );
  }

  async function checkLatestRoster() {
    if (checking || stopping) {
      return;
    }

    checking = true;

    try {
      const current = await roster();

      const eligible = new Set(
        current.usernames,
      );

      for (const username of failedUsers) {
        if (!eligible.has(username)) {
          failedUsers.delete(username);
        }
      }

      if (activeJob || stopping) {
        // Recheck on the next poll after active work finishes.
        return;
      }

      const fullDue =
        lastFullStarted === null ||
        now() - lastFullStarted >=
          fullInterval;

      const added =
        current.usernames.filter(
          (username) =>
            !seenRoster.has(username),
        );

      // New regional dates trigger a full pass.
      // Same-date arrivals/retries remain incremental
      // unless a manual full refresh expands them.
      const dateChanged =
        current.periodSignature !==
        latestSignature;

      const list =
        fullDue || dateChanged
          ? current.usernames
          : [
              ...new Set([
                ...added,
                ...failedUsers,
              ]),
            ];

      latestSignature =
        current.periodSignature;

      seenRoster.clear();

      current.usernames.forEach(
        (username) =>
          seenRoster.add(username),
      );

      if (
        fullDue ||
        dateChanged
      ) {
        lastFullStarted = now();
      }

      if (list.length) {
        launchJob(
          list,
          fullDue || dateChanged
            ? "scheduled-full"
            : "late-arrivals-or-retry",
        );
      }
    } catch {
      log(
        "Avatar roster check failed; existing photos unchanged. Will retry next poll.",
      );
    } finally {
      checking = false;
    }
  }

  const serializeJob = (job) => {
    const { promise, ...result } = job;

    return {
      ok: true,
      ...result,
    };
  };

  app.get("/health", (_req, res) =>
    res.json({
      ok: true,
      automatic,
      databaseConfigured:
        Boolean(pool),
      activeJobId:
        activeJob?.job_id ?? null,
    }),
  );

  app.get(
    "/api/tools/user_list",
    auth,
    async (_req, res) => {
      try {
        res.json(
          (await roster()).usernames,
        );
      } catch {
        res.status(503).json({
          ok: false,
          reason:
            "Latest regional rosters unavailable",
        });
      }
    },
  );

  app.post(
    "/api/tools/avatar_refresh",
    auth,
    async (req, res) => {
      try {
        const result =
          await refreshOne(
            req.body?.username,
          );

        res
          .status(
            result.ok ? 200 : 502,
          )
          .json(result);
      } catch {
        res.status(400).json({
          ok: false,
          reason:
            "Invalid username",
        });
      }
    },
  );

  app.post(
    "/api/tools/avatar_refresh_batch",
    auth,
    async (req, res) => {
      let list;

      try {
        if (
          !Array.isArray(
            req.body?.usernames,
          ) ||
          !req.body.usernames.length ||
          req.body.usernames.length >
            500
        ) {
          throw new Error();
        }

        list = [
          ...new Set(
            req.body.usernames.map(
              cleanUser,
            ),
          ),
        ];
      } catch {
        return res.status(400).json({
          ok: false,
          reason:
            "Provide 1–500 valid usernames",
        });
      }

      const results = {};

      await Promise.all(
        list.map(
          async (username) => {
            results[username] =
              await refreshOne(
                username,
              );
          },
        ),
      );

      res.json({
        ok: true,
        results,
      });
    },
  );

  app.post(
    "/api/tools/avatar_refresh_start",
    auth,
    async (_req, res) => {
      try {
        const {
          job,
          coalesced,
        } =
          await startLatestJob();

        res.json({
          ok: true,
          job_id: job.job_id,
          total: job.total,
          coalesced,
        });
      } catch {
        res.status(503).json({
          ok: false,
          reason:
            "Latest regional rosters unavailable",
        });
      }
    },
  );

  app.get(
    "/api/tools/avatar_refresh_status",
    auth,
    (req, res) => {
      const job = jobs.get(
        String(
          req.query.job_id ?? "",
        ),
      );

      if (!job) {
        return res.status(404).json({
          ok: false,
          reason:
            "job not found",
        });
      }

      res.json(
        serializeJob(job),
      );
    },
  );

  return {
    app,
    roster,
    refreshOne,
    startLatestJob,
    checkLatestRoster,

    startScheduler() {
      if (
        !automatic ||
        timer ||
        stopping
      ) {
        return;
      }

      if (!pool) {
        throw new Error(
          "AUTO_REFRESH requires DATABASE_URL",
        );
      }

      void checkLatestRoster();

      timer = setInterval(
        () =>
          void checkLatestRoster(),
        pollMs,
      );
    },

    async close() {
      stopping = true;

      if (timer) {
        clearInterval(timer);
      }

      await Promise.allSettled([
        ...inFlight.values(),
        ...(activeJob
          ? [activeJob.promise]
          : []),
      ]);

      if (!database) {
        await pool?.end();
      }

      if (!s3Client) {
        s3.destroy();
      }
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(
      process.argv[1],
    ).href
) {
  const tool =
    createAvatarTool();

  const server =
    tool.app.listen(
      Number(
        process.env.PORT ??
          8080,
      ),
      "0.0.0.0",
      () => {
        console.log(
          "Avatar tool listening",
        );

        tool.startScheduler();
      },
    );

  for (const signal of [
    "SIGTERM",
    "SIGINT",
  ]) {
    process.once(
      signal,
      async () => {
        server.close();

        await tool.close();

        process.exit(0);
      },
    );
  }
}
