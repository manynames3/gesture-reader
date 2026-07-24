export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

export function isPdfBytes(bytes: ArrayBuffer): boolean {
  const signature = new TextDecoder().decode(bytes.slice(0, 5));
  return signature === "%PDF-";
}
