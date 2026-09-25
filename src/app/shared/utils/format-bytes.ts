/** A size the way Windows Explorer's Properties shows one: "1.14 GB (1,234,567,890 bytes)" - binary units
 *  (1 KB = 1024 bytes), two decimals, and the exact byte count. Below 1 KB just "512 bytes". */
export function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const exact = `${bytes.toLocaleString('en-US')} bytes`;
  return unit === 0 ? exact : `${value.toFixed(2)} ${units[unit]} (${exact})`;
}

/** A size in megabytes, whatever its size, and the exact byte count: "1,177.38 MB (1,234,567,890 bytes)" - binary
 *  megabytes (1 MB = 1,048,576 bytes, as formatBytes and Windows Explorer count them), two decimals. */
export function formatMegabytes(bytes: number): string {
  const megabytes = (bytes / (1024 * 1024)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${megabytes} MB (${bytes.toLocaleString('en-US')} bytes)`;
}
