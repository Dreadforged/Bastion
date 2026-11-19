import { describe, expect, it } from "vitest";
import { R2S3Signer, presignUrl } from "../src/files/presign.js";

describe("presignUrl", () => {
  it("matches the AWS Signature V4 documentation example", async () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const url = await presignUrl({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      now: Date.UTC(2013, 4, 24),
      expiresSeconds: 86400,
    });
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
        "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
        "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });
});

describe("R2S3Signer", () => {
  const signer = new R2S3Signer({ accountId: "acct123", accessKeyId: "AKID", secretAccessKey: "shh", bucket: "bastion-files-dev" });
  const base = { key: "pending/01ARZ3NDEKTSV4RRFFQ69G5FAV", size: 1234, contentType: "image/png", expiresSeconds: 300, now: Date.UTC(2026, 10, 19, 4, 0, 0) };

  it("points at the bucket on R2's S3 endpoint and expires in five minutes", async () => {
    const { url, headers } = await signer.presignPut(base);
    const parsed = new URL(url);
    expect(parsed.host).toBe("acct123.r2.cloudflarestorage.com");
    expect(parsed.pathname).toBe("/bastion-files-dev/pending/01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(parsed.searchParams.get("X-Amz-Date")).toBe("20261119T040000Z");
    expect(parsed.searchParams.get("X-Amz-Credential")).toBe("AKID/20261119/auto/s3/aws4_request");
    expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(headers).toEqual({ "content-type": "image/png" });
  });

  it("signs the exact size and type so the URL cannot be reused for another file", async () => {
    const { url } = await signer.presignPut(base);
    expect(new URL(url).searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    const signature = (u: string) => new URL(u).searchParams.get("X-Amz-Signature");
    expect(signature((await signer.presignPut({ ...base, size: 1235 })).url)).not.toBe(signature(url));
    expect(signature((await signer.presignPut({ ...base, contentType: "image/jpeg" })).url)).not.toBe(signature(url));
    expect(signature((await signer.presignPut({ ...base, key: "pending/other" })).url)).not.toBe(signature(url));
    expect(signature((await signer.presignPut({ ...base, now: base.now + 1000 })).url)).not.toBe(signature(url));
    // Same input, same URL.
    expect((await signer.presignPut(base)).url).toBe(url);
  });

  it("does not put the secret key or the account's keys in the URL", async () => {
    const { url } = await signer.presignPut(base);
    expect(url).not.toContain("shh");
  });
});
