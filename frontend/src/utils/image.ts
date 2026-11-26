/**
 * Resize and compress a phone camera photo to a lightweight JPEG (~150-300KB)
 * so uploads stay fast while keeping book text crisp for Gemini Vision.
 */
export async function compressImage(
  file: File,
  maxDimension = 1024,
  quality = 0.75
): Promise<Blob> {
  const imageUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(imageUrl);
    const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
    const targetWidth = Math.max(1, Math.round(img.width * scale));
    const targetHeight = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return file;
    }

    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality)
    );
    return blob ?? file;
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load selected image."));
    img.src = src;
  });
}
