import { formatBeijingDateTime } from "./utils";

export interface CsvHeader {
  label: string;
  key: string;
  /** 单元格值的导出前转换，例如把 UTC 时间写成北京时间；缺省直接落值。 */
  format?: (value: any) => string;
}

export function exportToJsonFile(data: any, filename: string = "export.json") {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function buildCsvContent(headers: CsvHeader[], data: Record<string, any>[]): string {
  const headerRow = headers.map((h) => `"${h.label.replace(/"/g, '""')}"`).join(",");
  const dataRows = data.map((row) =>
    headers
      .map((h) => {
        const val = row[h.key];
        if (val === undefined || val === null) return '""';
        const formatted = h.format ? h.format(val) : val;
        const str = typeof formatted === "object" ? JSON.stringify(formatted) : String(formatted);
        return `"${str.replace(/"/g, '""')}"`;
      })
      .join(",")
  );

  return [headerRow, ...dataRows].join("\n");
}

export function exportToCsvFile(
  headers: CsvHeader[],
  data: Record<string, any>[],
  filename: string = "export.csv"
) {
  const csvContent = "\uFEFF" + buildCsvContent(headers, data);
  const blob = new Blob([csvContent], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * 导出前把指定字段转成北京时间字符串，供 JSON 导出与 CSV 保持同一种时间写法。
 * 非字符串或空值保持原样，交给导出的既有空值处理。
 */
export function withBeijingDateTimes<T extends Record<string, any>>(
  rows: T[],
  keys: readonly string[]
): T[] {
  return rows.map((row) => {
    const copy: Record<string, any> = { ...row };
    for (const key of keys) {
      const value = copy[key];
      if (typeof value === "string" && value.trim()) {
        copy[key] = formatBeijingDateTime(value);
      }
    }
    return copy as T;
  });
}
