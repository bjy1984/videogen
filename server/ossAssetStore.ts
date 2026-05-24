import OSS from "ali-oss";
import path from "node:path";

export interface OssSignedAsset {
  objectKey: string;
  signedUrl: string;
  expiresAt?: string;
}

interface OssClientLike {
  put(name: string, file: string, options?: Record<string, unknown>): Promise<unknown>;
  signatureUrl(name: string, options?: Record<string, unknown>): string;
}

let client: OssClientLike | undefined;

export function isOssConfigured() {
  return Boolean(
    process.env.OSS_BUCKET &&
      process.env.OSS_ENDPOINT &&
      process.env.OSS_ACCESS_KEY_ID &&
      process.env.OSS_ACCESS_KEY_SECRET
  );
}

export async function uploadAndSignOssAsset(input: {
  relativeDir: string;
  fileName: string;
  localPath: string;
  mime?: string;
}): Promise<OssSignedAsset | null> {
  if (!isOssConfigured()) return null;
  const objectKey = ossObjectKey(input.relativeDir, input.fileName);
  const oss = getOssClient();
  await oss.put(objectKey, input.localPath, {
    timeout: Number(process.env.OSS_UPLOAD_TIMEOUT_MS || 300_000),
    ...(input.mime ? { mime: input.mime } : {})
  });
  return signOssObject(objectKey);
}

export function signOssObject(objectKey: string): OssSignedAsset | null {
  if (!isOssConfigured()) return null;
  const publicBaseUrl = process.env.OSS_PUBLIC_BASE_URL?.replace(/\/+$/, "");
  if (publicBaseUrl) {
    return {
      objectKey,
      signedUrl: `${publicBaseUrl}/${objectKey.split("/").map(encodeURIComponent).join("/")}`
    };
  }
  const expires = Number(process.env.OSS_SIGNED_URL_EXPIRES_SEC || 86_400);
  const signedUrl = getOssClient().signatureUrl(objectKey, {
    expires,
    method: "GET"
  });
  return {
    objectKey,
    signedUrl,
    expiresAt: new Date(Date.now() + expires * 1000).toISOString()
  };
}

function getOssClient() {
  if (!client) {
    client = new OSS({
      region: process.env.OSS_REGION || "oss-cn-beijing",
      endpoint: process.env.OSS_ENDPOINT,
      bucket: process.env.OSS_BUCKET,
      accessKeyId: process.env.OSS_ACCESS_KEY_ID,
      accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
      secure: true
    }) as OssClientLike;
  }
  return client;
}

function ossObjectKey(relativeDir: string, fileName: string) {
  const prefix = (process.env.OSS_PREFIX || "videogen").replace(/^\/+|\/+$/g, "");
  const relativeKey = relativeDir.split(path.sep).filter(Boolean).join("/");
  return [prefix, relativeKey, fileName].filter(Boolean).join("/");
}
