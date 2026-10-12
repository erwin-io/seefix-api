import test from "node:test";
import assert from "node:assert/strict";
import { v2 as cloudinary } from "cloudinary";
import {
  signUpload,
  claimUploads,
  ownerTag,
  purposeTag,
  PENDING_TAG,
  MAX_IMAGE_BYTES,
  MAX_DOCUMENT_BYTES,
} from "../src/direct-uploads.js";

const credentials = { cloudName: "demo", apiKey: "key", apiSecret: "secret" };
const reporter = { id: "u1", role: "REPORTER" };
const procurement = { id: "p1", role: "PROCUREMENT" };

const resource = (publicId, over = {}) => ({
  public_id: publicId,
  resource_type: "image",
  format: "jpg",
  bytes: 1000,
  tags: [PENDING_TAG, ownerTag("u1"), purposeTag("report-image")],
  ...over,
});
const unused = async () => ({ rowCount: 0 });
const claim = (user, purpose, refs, resources, q = unused) =>
  claimUploads(user, purpose, refs, { fetchResource: async (id) => resources[id] ?? null, q });

test("signUpload signs folder, tags and formats, and reports the per-purpose limit", () => {
  const signed = signUpload(reporter, "report-image", { credentials, now: () => 1_700_000_000_000 });
  assert.equal(signed.uploadUrl, "https://api.cloudinary.com/v1_1/demo/image/upload");
  assert.equal(signed.maxBytes, MAX_IMAGE_BYTES);
  const { api_key, signature, ...params } = signed.fields;
  assert.equal(api_key, "key");
  assert.equal(signature, cloudinary.utils.api_sign_request(params, "secret"));
  assert.equal(params.tags, `${PENDING_TAG},${ownerTag("u1")},${purposeTag("report-image")}`);
  assert.equal(params.allowed_formats, "jpg,png,webp");

  const doc = signUpload(procurement, "procurement-document", { credentials });
  assert.match(doc.uploadUrl, /\/auto\/upload$/);
  assert.equal(doc.maxBytes, MAX_DOCUMENT_BYTES);
  assert.equal(doc.fields.allowed_formats, undefined);
});

test("signUpload rejects unknown purposes and roles that can't upload for the purpose", () => {
  assert.throws(() => signUpload(reporter, "avatar", { credentials }), { code: "INVALID_UPLOAD_PURPOSE" });
  assert.throws(() => signUpload(reporter, "completion-image", { credentials }), { status: 403 });
  assert.throws(() => signUpload(reporter, "procurement-document", { credentials }), { status: 403 });
});

test("claimUploads returns resources in order when every check passes", async () => {
  const out = await claim(reporter, "report-image", ["a", "b"], { a: resource("a"), b: resource("b") });
  assert.deepEqual(out.map((r) => r.public_id), ["a", "b"]);
});

test("claimUploads rejects each kind of bad upload", async () => {
  const cases = [
    [[], {}, "UPLOAD_REQUIRED"],
    [["a", "b", "c", "d", "e", "f"], {}, "TOO_MANY_FILES"],
    [["a", "a"], { a: resource("a") }, "DUPLICATE_UPLOAD"],
    [["missing"], {}, "UPLOAD_NOT_FOUND"],
    [["x"], { x: resource("x", { tags: [PENDING_TAG, ownerTag("other"), purposeTag("report-image")] }) }, "UPLOAD_NOT_ALLOWED"],
    [["x"], { x: resource("x", { tags: [PENDING_TAG, ownerTag("u1"), purposeTag("completion-image")] }) }, "UPLOAD_NOT_ALLOWED"],
    [["x"], { x: resource("x", { format: "gif" }) }, "UNSUPPORTED_IMAGE_TYPE"],
    [["x"], { x: resource("x", { bytes: MAX_IMAGE_BYTES + 1 }) }, "FILE_TOO_LARGE"],
    [["x"], { x: resource("x", { bytes: 0 }) }, "FILE_TOO_LARGE"],
  ];
  for (const [refs, resources, code] of cases) {
    await assert.rejects(claim(reporter, "report-image", refs, resources), { code }, code);
  }
  await assert.rejects(
    claim(reporter, "report-image", ["a"], { a: resource("a") }, async () => ({ rowCount: 1 })),
    { code: "UPLOAD_ALREADY_USED", status: 409 },
  );
});

test("procurement documents allow any format up to 15 MB and need image or raw resourceType", async () => {
  const tags = [PENDING_TAG, ownerTag("p1"), purposeTag("procurement-document")];
  const pdf = resource("d", { resource_type: "raw", format: undefined, bytes: MAX_DOCUMENT_BYTES, tags });
  const [doc] = await claim(procurement, "procurement-document", [{ publicId: "d", resourceType: "raw" }], { d: pdf });
  assert.equal(doc.public_id, "d");
  await assert.rejects(
    claim(procurement, "procurement-document", [{ publicId: "d", resourceType: "raw" }], { d: { ...pdf, bytes: MAX_DOCUMENT_BYTES + 1 } }),
    { code: "FILE_TOO_LARGE" },
  );
  await assert.rejects(
    claim(procurement, "procurement-document", [{ publicId: "d", resourceType: "video" }], { d: pdf }),
    { code: "VALIDATION_ERROR" },
  );
});
