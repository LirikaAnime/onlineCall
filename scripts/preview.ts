import { extname, join, normalize, relative } from "node:path";

const root = join(process.cwd(), "out");
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "127.0.0.1";
const fallbackLimit = Number(process.env.PORT_FALLBACK_LIMIT ?? 10);

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

function isInsideRoot(pathname: string) {
  const rel = relative(root, pathname);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

async function existingFile(pathname: string) {
  const file = Bun.file(pathname);
  return (await file.exists()) ? file : null;
}

async function resolveFile(request: Request) {
  const url = new URL(request.url);
  const rawPath = decodeURIComponent(url.pathname);
  const normalized = normalize(rawPath).replace(/^(\.\.[/\\])+/, "");
  const candidate = join(root, normalized);

  if (!isInsideRoot(candidate)) {
    return null;
  }

  const direct = await existingFile(candidate);
  if (direct) {
    return direct;
  }

  const [, firstSegment, ...restSegments] = normalized.split("/");
  if (firstSegment && restSegments.length) {
    const withoutBasePath = join(root, restSegments.join("/"));
    if (isInsideRoot(withoutBasePath)) {
      const basePathFile = await existingFile(withoutBasePath);
      if (basePathFile) {
        return basePathFile;
      }
    }
  }

  const index = await existingFile(join(candidate, "index.html"));
  if (index) {
    return index;
  }

  if (!extname(candidate)) {
    return existingFile(join(root, "index.html"));
  }

  return null;
}

function serve(candidatePort: number) {
  return Bun.serve({
    hostname,
    port: candidatePort,
    async fetch(request) {
      const file = await resolveFile(request);
      if (!file) {
        return new Response("Not found", { status: 404 });
      }

      return new Response(file, {
        headers: {
          "content-type": mimeTypes[extname(file.name ?? "")] ?? "application/octet-stream"
        }
      });
    }
  });
}

let server: ReturnType<typeof Bun.serve> | null = null;
let selectedPort = port;

for (let offset = 0; offset <= fallbackLimit; offset += 1) {
  const candidatePort = port + offset;
  try {
    server = serve(candidatePort);
    selectedPort = candidatePort;
    break;
  } catch (error) {
    const isPortBusy =
      error instanceof Error &&
      ("code" in error || "message" in error) &&
      ((error as Error & { code?: string }).code === "EADDRINUSE" ||
        error.message.includes("EADDRINUSE"));

    if (!isPortBusy || offset === fallbackLimit) {
      throw error;
    }
  }
}

if (!server) {
  throw new Error("Не удалось запустить preview-сервер.");
}

if (selectedPort !== port) {
  console.warn(`Port ${port} is busy. Using ${selectedPort} instead.`);
}

console.log(`Serving ${root} at http://${hostname}:${selectedPort}/`);
