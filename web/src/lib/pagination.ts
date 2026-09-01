/** 页码条上的一项：数字是可点的页码，字符串是省略号占位。 */
export type PageItem = number | string;

/**
 * 算出页码条要显示哪些页码。
 *
 * 五页以内全列出来；更多就只留当前页附近的三页，两端补上首页和末页，断开的
 * 地方插省略号——页码条的宽度不该跟着总页数一起长。相邻的两页之间不插省略号，
 * 那个位置放个「...」比直接写出被它挡住的那一页还宽。
 */
export function getPageItems(currentPage: number, totalPages: number): PageItem[] {
  if (totalPages <= 5) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  // 默认显示以当前页为中心的 3 个页码窗口
  let start = Math.max(1, currentPage - 1);
  let end = Math.min(totalPages, currentPage + 1);

  if (currentPage <= 2) {
    start = 1;
    end = 3;
  } else if (currentPage >= totalPages - 1) {
    start = totalPages - 2;
    end = totalPages;
  }

  const pages: PageItem[] = [];

  if (start > 1) {
    pages.push(1);
    if (start > 2) {
      pages.push("ellipsis-start");
    }
  }

  for (let i = start; i <= end; i++) {
    pages.push(i);
  }

  if (end < totalPages) {
    if (end < totalPages - 1) {
      pages.push("ellipsis-end");
    }
    pages.push(totalPages);
  }

  return pages;
}
