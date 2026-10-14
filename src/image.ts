// Shrinks a photo before upload so it works on slow connections: ≤ 1600 px on the long side, JPEG 0.8.
// Falls back to the original file if the browser can't decode or encode it.
export async function compressImage(file: File, maxSide = 1600, quality = 0.8): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", quality));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

/** PUT a file to a Supabase Storage signed upload URL. */
export async function uploadTo(url: string, blob: Blob): Promise<void> {
  const res = await fetch(url, { method: "PUT", headers: { "content-type": blob.type, "x-upsert": "false" }, body: blob })
    .catch(() => null);
  if (!res?.ok) throw new Error("The upload didn't go through. Please check your internet and try again.");
}

let tesseract: Promise<unknown> | null = null;

/** OCR in the browser. Tesseract (~3 MB with language data) loads only when a slip is picked. */
export async function readText(blob: Blob): Promise<string> {
  tesseract ??= new Promise((ok, fail) => {
    const s = Object.assign(document.createElement("script"), {
      src: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js", onload: ok, onerror: fail,
    });
    document.head.append(s);
  });
  await tesseract;
  // deno-lint-ignore no-explicit-any
  const { data } = await (window as any).Tesseract.recognize(blob, "eng");
  return data.text as string;
}
