import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import { ROOT_DIR, config, ensureDirs, modeLines } from "./config.js";
import { migrate } from "./db.js";
import { startRunner } from "./jobs/runner.js";
import { router as adminRouter } from "./routes/admin.js";
import { router as creditsRouter } from "./routes/credits.js";
import { router as marketingRouter } from "./routes/marketing.js";
import { router as orderRouter } from "./routes/order.js";
import { router as reportRouter } from "./routes/report.js";
import { router as teaserRouter } from "./routes/teaser.js";
import { router as webhookRouter } from "./routes/webhook.js";
import { HttpError } from "./util/http.js";
import { renderPage } from "./util/render.js";

const GENERIC_SERVER_ERROR = "Something went wrong on our side. Reply to your receipt email and we'll fix it.";

interface ErrorLike {
  name?: unknown;
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  type?: unknown;
  message?: unknown;
  expose?: unknown;
  stack?: unknown;
}

interface ClassifiedError {
  status: number;
  code: string;
  message: string;
}

/** Turns anything thrown by a route or middleware into a status, machine code and human message. */
function classifyError(err: unknown): ClassifiedError {
  if (err instanceof HttpError) {
    return { status: err.status, code: err.code, message: err.message };
  }
  const e: ErrorLike = typeof err === "object" && err !== null ? (err as ErrorLike) : {};
  if (e.name === "MulterError") {
    const code = typeof e.code === "string" ? e.code : "upload_error";
    const message =
      code === "LIMIT_FILE_SIZE" ? "That file is too large. Logos must be 1 MB or smaller." : "That upload could not be accepted.";
    return { status: 400, code: code.toLowerCase(), message };
  }
  const rawStatus = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : 500;
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus < 600 ? rawStatus : 500;
  if (status >= 500) {
    return { status, code: "server_error", message: GENERIC_SERVER_ERROR };
  }
  if (e.type === "entity.too.large") {
    return { status, code: "payload_too_large", message: "That request is too large." };
  }
  if (e.type === "entity.parse.failed") {
    return { status, code: "invalid_json", message: "The request body is not valid JSON." };
  }
  const message = typeof e.message === "string" && e.message.trim() !== "" ? e.message : "The request could not be processed.";
  const code = typeof e.code === "string" ? e.code.toLowerCase() : status === 404 ? "not_found" : "bad_request";
  return { status, code, message };
}

const notFound: RequestHandler = (_req, _res, next) => {
  next(new HttpError(404, "We couldn't find that page. Check the address or head back to the home page.", "not_found"));
};

const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const { status, code, message } = classifyError(err);
  if (status >= 500) {
    const stack = typeof err === "object" && err !== null && "stack" in err ? (err as ErrorLike).stack : err;
    console.error(`[${status}] ${req.method} ${req.originalUrl}`, stack);
  }
  if (req.path.startsWith("/api/")) {
    res.status(status).json({ error: code, message });
    return;
  }
  renderPage(res, "error", { title: status === 404 ? "Page not found" : "Error", status, code, message }, status).catch(
    (renderErr: unknown) => {
      console.error("error page failed to render", renderErr);
      if (!res.headersSent) res.status(status).type("text/plain").send(`${status} ${message}`);
    },
  );
};

/**
 * Builds the Express app without listening (used by tests and by main()).
 * Middleware order matters: static files, then the raw-body Stripe webhook,
 * then JSON/urlencoded parsers, then every page router, then 404 + errors.
 */
export function createApp(): Express {
  ensureDirs();
  migrate();

  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.set("etag", false);

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    next();
  });

  app.use(
    express.static(path.join(ROOT_DIR, "public"), {
      index: false,
      maxAge: config.nodeEnv === "production" ? "1h" : 0,
    }),
  );

  // Stripe must verify the signature over the raw bytes, so this path gets the
  // raw parser and its router is mounted before express.json().
  app.use("/api/stripe/webhook", express.raw({ type: "application/json", limit: "1mb" }));
  app.use(webhookRouter);

  app.use(express.json({ limit: "100kb" }));
  app.use("/admin", express.urlencoded({ extended: false, limit: "2mb" }));
  app.use(express.urlencoded({ extended: false, limit: "100kb" }));

  app.use(marketingRouter);
  app.use(teaserRouter);
  app.use(orderRouter);
  app.use(creditsRouter);
  app.use(reportRouter);
  app.use(adminRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

function main(): void {
  process.on("unhandledRejection", (reason) => {
    console.error("unhandledRejection", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("uncaughtException", err);
  });

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`AccessAudit listening on port ${config.port} (${config.baseUrl}) [${config.nodeEnv}]`);
    for (const line of modeLines()) console.log(line);
    startRunner();
  });

  const shutdown = (signal: string): void => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (isEntryPoint()) {
  main();
}
