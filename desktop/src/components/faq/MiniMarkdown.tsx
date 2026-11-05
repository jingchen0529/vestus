import React, { Fragment, useMemo } from "react";
import { parseMiniMarkdown, type MiniInline } from "@/lib/mini-markdown";
import { cn } from "@/lib/utils";

/**
 * 受限 Markdown 的渲染层：把解析结果映射成 React 元素，全程不拼 HTML 字符串，
 * 因此后台写什么都不会被当成标签执行。语法范围见 `@/lib/mini-markdown`。
 */
const renderInline = (nodes: MiniInline[]) =>
  nodes.map((node, index) =>
    node.type === "strong" ? (
      <strong key={index} className="font-semibold text-foreground">
        {node.text}
      </strong>
    ) : (
      <Fragment key={index}>{node.text}</Fragment>
    ),
  );

export const MiniMarkdown: React.FC<{ source: string; className?: string }> = ({
  source,
  className,
}) => {
  const blocks = useMemo(() => parseMiniMarkdown(source), [source]);

  if (blocks.length === 0) return null;

  return (
    <div className={cn("space-y-2", className)}>
      {blocks.map((block, index) => {
        if (block.type === "list") {
          const items = block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item)}</li>
          ));
          return block.ordered ? (
            <ol key={index} className="list-decimal space-y-1 pl-4 marker:text-muted-foreground/60">
              {items}
            </ol>
          ) : (
            <ul key={index} className="list-disc space-y-1 pl-4 marker:text-muted-foreground/60">
              {items}
            </ul>
          );
        }

        return (
          <p key={index} className="whitespace-pre-wrap">
            {block.lines.map((line, lineIndex) => (
              <Fragment key={lineIndex}>
                {lineIndex > 0 ? "\n" : null}
                {renderInline(line)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
};
