// PayMV QR rendering. The payload is built and checksummed by the server.
import qrcode from "qrcode-generator";

function make(payload: string) {
  const q = qrcode(0, "M");
  q.addData(payload);
  q.make();
  return q;
}

export const qrSvg = (payload: string) => make(payload).createSvgTag({ cellSize: 4, margin: 4, scalable: true });

/** PNG of the QR, for saving to the phone's photos (bank apps can scan a saved image). */
export function qrPngUrl(payload: string): string {
  const q = make(payload);
  const cell = 10, margin = 4, size = (q.getModuleCount() + margin * 2) * cell;
  const c = Object.assign(document.createElement("canvas"), { width: size, height: size });
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, size, size);
  g.fillStyle = "#000";
  for (let r = 0; r < q.getModuleCount(); r++) {
    for (let col = 0; col < q.getModuleCount(); col++) {
      if (q.isDark(r, col)) g.fillRect((col + margin) * cell, (r + margin) * cell, cell, cell);
    }
  }
  return c.toDataURL("image/png");
}
