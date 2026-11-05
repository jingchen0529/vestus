import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { tauriBridge, type DesktopFaqGroupView } from "@/services/tauriBridge";
import { MiniMarkdown } from "@/components/faq/MiniMarkdown";
import { cn } from "@/lib/utils";
import baseline from "@/assets/desktopFaqBaseline.json";

const CACHE_KEY = "vestus-desktop-faq-cache";

type FaqGroups = DesktopFaqGroupView[];

function readCache(): FaqGroups | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.groups)) return parsed.groups as FaqGroups;
  } catch {
    // 缓存坏了等同没有缓存，走内置基线。
  }
  return null;
}

function writeCache(groups: FaqGroups) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ groups }));
  } catch {
    // 内容是公开文本，写不进缓存只影响离线兜底。
  }
}

function clearCache() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // ignore
  }
}

/**
 * 「常见问题」独立菜单页。三级降级：服务端自定义内容 → 本地缓存 → 随版本
 * 打包的内置基线（desktopFaqBaseline.json，与后台模板同源，改动需两处同步）。
 *
 * 页面渲染策略：首帧直接用本地缓存/内置基线渲染，拉取只做后台静默刷新，
 * 内容没变化时不触碰状态——切换菜单再回来永远看不到转圈和闪动。
 */
export const FaqView: React.FC = () => {
  const [groups, setGroups] = useState<FaqGroups>(() => readCache() ?? (baseline.groups as FaqGroups));
  // 默认全部分组展开；点击标题仍可折叠。
  const [openKeys, setOpenKeys] = useState<Set<number>>(
    () => new Set(groups.map((_, index) => index)),
  );
  const [loading, setLoading] = useState(false);

  /**
   * 题号在全页连续编号（Q1…Qn），与客户文档 Q1–Q14 的口径一致；
   * 编号由当前展示的顺序算出来，不写进后台数据，增删条目后不会错位。
   */
  const offsets = useMemo(() => {
    let running = 0;
    return groups.map((group) => {
      const start = running;
      running += group.items.length;
      return start;
    });
  }, [groups]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await tauriBridge.fetchDesktopFaq();
      let next: FaqGroups;
      if (payload && payload.groups.length > 0) {
        next = payload.groups;
        writeCache(next);
      } else {
        // 后台未自定义：回到内置基线，过期缓存一并清掉。
        next = baseline.groups as FaqGroups;
        clearCache();
      }
      // 内容没变就不碰状态，避免一次无意义的重渲染。
      setOpenKeys(new Set(next.map((_, index) => index)));
      setGroups((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    } catch {
      // 拉取失败（弱网/未登录态切换）：静默保留当前展示的内容，不打扰用户。
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleGroup = (index: number) => {
    setOpenKeys((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <section className="mx-auto w-full max-w-3xl space-y-3.5">
      <header className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-[-0.02em] text-foreground">
            常见问题
          </h2>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
            使用客户端时的常见疑问与处理办法；界面以实际安装版本为准
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="flex shrink-0 items-center gap-1 rounded-full border border-border/70 bg-card px-2.5 py-1 text-[10.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          title="重新获取最新内容"
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          刷新
        </button>
      </header>

      <div className="space-y-2.5">
        {groups.map((group, groupIndex) => {
          const open = openKeys.has(groupIndex);
          return (
            <div
              key={`${groupIndex}-${group.title}`}
              className="overflow-hidden rounded-[12px] border border-border/70 bg-card transition-colors hover:border-border"
            >
              <button
                type="button"
                onClick={() => toggleGroup(groupIndex)}
                className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
              >
                <span className="truncate text-[13.5px] font-medium text-foreground">
                  {group.title}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                    {group.items.length}
                  </span>
                  <ChevronDown
                    className={cn(
                      "h-4 w-4 text-muted-foreground transition-transform duration-200",
                      open && "rotate-180",
                    )}
                  />
                </span>
              </button>
              {open && (
                <div className="space-y-2 border-t border-border/60 px-4 py-3">
                  {group.items.map((item, itemIndex) => (
                    <FaqItem
                      key={`${groupIndex}-${itemIndex}`}
                      no={offsets[groupIndex] + itemIndex + 1}
                      question={item.question}
                      answer={item.answer}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="pt-1 text-center text-[10.5px] leading-relaxed text-muted-foreground/70">
        以上内容未覆盖的问题，请联系管理员或渠道客服
      </p>
    </section>
  );
};

const FaqItem: React.FC<{ no: number; question: string; answer: string }> = ({
  no,
  question,
  answer,
}) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-[10px] border border-border/60 bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-start justify-between gap-2 px-3 py-2.5 text-left"
      >
        <span className="flex min-w-0 items-start gap-2">
          {/* 题号由列表顺序算出来，不写进数据：调整顺序后编号自动跟对 */}
          <span className="mt-px shrink-0 rounded bg-card px-1.5 py-px text-[10px] font-semibold leading-4 tabular-nums text-muted-foreground">
            Q{no}
          </span>
          <span className="text-[12.5px] font-medium leading-relaxed text-foreground">
            {question}
          </span>
        </span>
        <ChevronDown
          className={cn(
            "mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="border-t border-border/40 px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
          <MiniMarkdown source={answer} />
        </div>
      )}
    </div>
  );
};
