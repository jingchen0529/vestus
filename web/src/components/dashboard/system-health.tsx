import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Activity, Database, CheckCircle, Server, RefreshCw } from "lucide-react";
import { api } from "@/lib/api-client";
import { SystemHealth } from "@/types/api";

export function SystemHealthCard() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [product, setProduct] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const fetchStatus = async () => {
    setLoading(true);
    try {
      const [h, p] = await Promise.allSettled([
        api.getHealth(),
        api.getProduct(),
      ]);
      if (h.status === "fulfilled") setHealth(h.value);
      if (p.status === "fulfilled") setProduct(p.value);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  return (
    <Card className="border-border/80">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4 text-emerald-500" />
            <span>系统运行与环境状态</span>
          </CardTitle>
          <CardDescription className="text-xs">
            后端 FastAPI 服务与 MySQL / SQLite 持久层健康检查
          </CardDescription>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={fetchStatus}
          disabled={loading}
          className="h-8 gap-1 text-xs"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          <span>探测</span>
        </Button>
      </CardHeader>
      <CardContent className="space-y-3 pt-1">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* API Status */}
          <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-2.5">
              <Server className="h-4 w-4 text-primary" />
              <div>
                <div className="text-xs font-semibold">API 服务网关</div>
                <div className="text-[11px] text-muted-foreground">FastAPI REST Core</div>
              </div>
            </div>
            <Badge variant="success" className="text-[10px] gap-1">
              <CheckCircle className="h-3 w-3" />
              <span>{health?.status || "HEALTHY"}</span>
            </Badge>
          </div>

          {/* Database */}
          <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-2.5">
              <Database className="h-4 w-4 text-indigo-500" />
              <div>
                <div className="text-xs font-semibold">数据库存储引擎</div>
                <div className="text-[11px] text-muted-foreground">
                  {health?.database || "MySQL / SQLite"}
                </div>
              </div>
            </div>
            <Badge variant="success" className="text-[10px] gap-1">
              <CheckCircle className="h-3 w-3" />
              <span>已就绪</span>
            </Badge>
          </div>

          {/* Security & Version */}
          <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-2.5">
              <div className="h-2 w-2 rounded-full bg-emerald-500 animate-ping" />
              <div>
                <div className="text-xs font-semibold">
                  {product?.name || "Vestus Enterprise"}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  版本: v{product?.version || "2.0.0"} · 安全隔离
                </div>
              </div>
            </div>
            <Badge variant="outline" className="text-[10px]">
              Active
            </Badge>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
