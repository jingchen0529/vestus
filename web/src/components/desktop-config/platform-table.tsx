import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { PlatformItem } from "@/types/platform";
import { Globe, Plus, Edit2, CheckCircle2, XCircle, ExternalLink, RefreshCw } from "lucide-react";

interface PlatformTableProps {
  platforms: PlatformItem[];
  onOpenCreate: () => void;
  onEditPlatform: (platform: PlatformItem) => void;
  onRefresh: () => void;
  isLoading?: boolean;
}

export function PlatformTable({
  platforms,
  onOpenCreate,
  onEditPlatform,
  onRefresh,
  isLoading,
}: PlatformTableProps) {
  const activeCount = platforms.filter((p) => p.status === "active").length;

  return (
    <Card className="border-border/80 shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <Globe className="h-4 w-4 text-indigo-500" />
            <span>平台管理 ({platforms.length} 个)</span>
          </CardTitle>
          <CardDescription className="text-xs">
            正常投放: {activeCount} 个 · 已下架: {platforms.length - activeCount} 个
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={isLoading}
            className="h-8 gap-1 text-xs"
          >
            <RefreshCw className={`h-3 w-3 ${isLoading ? "animate-spin" : ""}`} />
            <span>刷新</span>
          </Button>
          <Button
            onClick={onOpenCreate}
            size="sm"
            className="h-8 gap-1 text-xs bg-indigo-600 hover:bg-indigo-700 text-white font-semibold"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>新增平台</span>
          </Button>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {platforms.length === 0 ? (
          <div className="py-10 text-center text-xs text-muted-foreground">
            暂无业务平台，点击右上角【新增平台】录入
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>平台名称</TableHead>
                <TableHead>访问入口地址</TableHead>
                <TableHead className="w-[80px] text-center">排序</TableHead>
                <TableHead className="w-[100px]">状态</TableHead>
                <TableHead className="w-[100px] text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {platforms.map((platform) => (
                <TableRow key={platform.id} className="hover:bg-muted/40 transition-colors text-xs">
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-semibold text-foreground">{platform.name}</span>
                      <span className="text-[11px] text-muted-foreground">#{platform.id}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <a
                      href={platform.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 font-mono text-primary hover:underline truncate max-w-xs"
                    >
                      <span className="truncate">{platform.url}</span>
                      <ExternalLink className="h-3 w-3 shrink-0 opacity-70" />
                    </a>
                  </TableCell>
                  <TableCell className="text-center font-mono">
                    {platform.sortOrder}
                  </TableCell>
                  <TableCell>
                    {platform.status === "active" ? (
                      <Badge variant="success" className="gap-1 text-[10px]">
                        <CheckCircle2 className="h-3 w-3" />
                        <span>启用</span>
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="gap-1 text-[10px]">
                        <XCircle className="h-3 w-3" />
                        <span>停用</span>
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onEditPlatform(platform)}
                      className="h-7 px-2 text-xs gap-1 text-primary hover:text-primary"
                    >
                      <Edit2 className="h-3 w-3" />
                      <span>编辑</span>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
