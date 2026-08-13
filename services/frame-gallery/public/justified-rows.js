const FALLBACK_RATIO = 4 / 3;

export function planJustifiedRows(ratios, width, targetHeight, gap = 5) {
  if (!ratios.length || width < 1 || targetHeight < 1) return [];
  const normalized = ratios.map((ratio) => Number.isFinite(Number(ratio)) && Number(ratio) > 0 ? Number(ratio) : FALLBACK_RATIO);
  const rows = [];
  let row = [];
  let ratioTotal = 0;

  const finishRow = (last) => {
    const available = width - gap * Math.max(0, row.length - 1);
    const fillHeight = available / ratioTotal;
    const partial = last && fillHeight > targetHeight * 1.5;
    rows.push({ items: row, height: partial ? targetHeight : fillHeight, partial });
    row = [];
    ratioTotal = 0;
  };

  normalized.forEach((ratio, index) => {
    const currentWidth = ratioTotal * targetHeight + gap * Math.max(0, row.length - 1);
    const projectedWidth = currentWidth + (row.length ? gap : 0) + ratio * targetHeight;
    if (row.length && projectedWidth > width && index < normalized.length - 1) {
      const nextIsPenultimate = index === normalized.length - 2;
      const includeNext = !nextIsPenultimate && width - currentWidth > projectedWidth - width;
      if (includeNext) {
        row.push({ index, ratio });
        ratioTotal += ratio;
        finishRow(false);
        return;
      }
      finishRow(false);
    }
    row.push({ index, ratio });
    ratioTotal += ratio;
    if (index === normalized.length - 1) finishRow(true);
  });

  return rows;
}

export function layoutJustifiedRows(container, items, { rowClass, targetHeight, gap = 5 }) {
  const rows = planJustifiedRows(items.map((item) => item.dataset.ratio), container.clientWidth, targetHeight, gap);
  if (!rows.length) return;
  const activeElement = items.some((item) => item.contains(container.ownerDocument.activeElement))
    ? container.ownerDocument.activeElement
    : null;
  const rowElements = rows.map((row) => {
    const element = container.ownerDocument.createElement("div");
    element.className = `${rowClass}${row.partial ? " is-partial" : ""}`;
    for (const entry of row.items) {
      const item = items[entry.index];
      item.style.aspectRatio = String(entry.ratio);
      item.style.flex = row.partial ? "none" : `${entry.ratio * 100} 1 0px`;
      item.style.width = row.partial ? `${Math.max(1, entry.ratio * row.height)}px` : "";
      item.style.height = row.partial ? `${Math.max(1, row.height)}px` : "";
      element.append(item);
    }
    return element;
  });
  container.replaceChildren(...rowElements);
  if (activeElement?.isConnected) activeElement.focus({ preventScroll: true });
}
