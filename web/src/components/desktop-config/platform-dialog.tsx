import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PlatformItem, CreatePlatformPayload, UpdatePlatformPayload } from "@/types/platform";
import { Globe, Upload, RefreshCw, X, Image as ImageIcon } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  BRAND_IMAGE_ACCEPT,
  requireStoredUploadPath,
  validateBrandImage,
} from "@/lib/upload-paths";

interface PlatformDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  platformToEdit?: PlatformItem | null;
  onSubmitCreate: (payload: CreatePlatformPayload) => Promise<void>;
  onSubmitUpdate: (id: number, payload: UpdatePlatformPayload) => Promise<void>;
}

export function PlatformDialog({
  open,
  onOpenChange,
  platformToEdit,
  onSubmitCreate,
  onSubmitUpdate,
}: PlatformDialogProps) {
  const isEditing = !!platformToEdit;

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [iconUrl, setIconUrl] = useState("");
  const [sortOrder, setSortOrder] = useState<number | string>(0);
  const [status, setStatus] = useState<"active" | "disabled">("active");
  const [loading, setLoading] = useState(false);
  const [isUploadingIcon, setIsUploadingIcon] = useState(false);

  useEffect(() => {
    if (platformToEdit) {
      setName(platformToEdit.name || "");
      setUrl(platformToEdit.url || "");
      setIconUrl(platformToEdit.iconUrl || "");
      setSortOrder(platformToEdit.sortOrder ?? 0);
      setStatus(platformToEdit.status || "active");
    } else {
      setName("");
      setUrl("https://");
      setIconUrl("");
      setSortOrder(0);
      setStatus("active");
    }
  }, [platformToEdit, open]);

  const handleIconFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const validationError = validateBrandImage(file);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    setIsUploadingIcon(true);
    try {
      const res = await api.uploadFile(file);
      setIconUrl(requireStoredUploadPath(res));
      toast.success("平台图标上传成功");
    } catch (error) {
      toast.error("平台图标上传失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setIsUploadingIcon(false);
      e.target.value = "";
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("请输入平台名称");
      return;
    }
    const trimmedUrl = url.trim();
    if (!trimmedUrl.startsWith("http://") && !trimmedUrl.startsWith("https://")) {
      toast.error("访问地址必须以 http:// 或 https:// 开头");
      return;
    }
    const orderNum = Number(sortOrder);
    if (!Number.isSafeInteger(orderNum) || orderNum < 0) {
      toast.error("排序值必须是大于等于 0 的整数");
      return;
    }

    setLoading(true);
    try {
      if (isEditing && platformToEdit) {
        await onSubmitUpdate(platformToEdit.id, {
          name: name.trim(),
          url: trimmedUrl,
          iconUrl: iconUrl.trim() || undefined,
          sortOrder: orderNum,
          status,
        });
        toast.success(`平台 ${name} 已更新`);
      } else {
        await onSubmitCreate({
          name: name.trim(),
          url: trimmedUrl,
          iconUrl: iconUrl.trim() || undefined,
          sortOrder: orderNum,
          status,
        });
        toast.success(`平台 ${name} 创建成功`);
      }
      onOpenChange(false);
    } catch (err: any) {
      toast.error(isEditing ? "保存失败" : "创建失败", {
        description: err.message || "请核对参数",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <div className="flex items-center gap-2 text-primary mb-1">
            <Globe className="h-5 w-5" />
            <DialogTitle>{isEditing ? "编辑业务平台" : "新增业务平台入口"}</DialogTitle>
          </div>
          <DialogDescription className="text-xs">
            为桌面客户端提供一键直达且受控的业务平台快捷入口，支持上传专属图标
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          {/* Icon Upload & Platform Name */}
          <div className="flex items-start gap-4">
            {/* Icon Uploader */}
            <div className="space-y-1.5 shrink-0">
              <Label className="text-xs">平台图标</Label>
              <label
                className={cn(
                  "relative group flex flex-col items-center justify-center w-20 h-20 rounded-xl border-2 border-dashed transition-all overflow-hidden cursor-pointer select-none bg-slate-50/80 dark:bg-slate-900/40",
                  isUploadingIcon
                    ? "opacity-60 cursor-not-allowed border-muted-foreground/30"
                    : "border-primary/40 hover:border-primary hover:bg-primary/5 shadow-2xs"
                )}
                title="点击上传或更换平台图标"
              >
                <input
                  type="file"
                  accept={BRAND_IMAGE_ACCEPT}
                  className="hidden"
                  onChange={handleIconFile}
                  disabled={loading || isUploadingIcon}
                />
                {iconUrl ? (
                  <>
                    <img
                      src={iconUrl}
                      alt="Platform Icon"
                      className="w-full h-full object-contain p-2 transition-transform duration-200 group-hover:scale-105"
                    />
                    <div className="absolute inset-0 bg-black/50 backdrop-blur-[1px] opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex flex-col items-center justify-center text-white text-[10px] font-medium gap-1">
                      <Upload className="w-3.5 h-3.5" />
                      <span>更换</span>
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center text-slate-400 group-hover:text-primary transition-colors gap-1">
                    <ImageIcon className="w-6 h-6 stroke-[1.5]" />
                    <span className="text-[9px] font-medium">上传图标</span>
                  </div>
                )}
                {isUploadingIcon && (
                  <div className="absolute inset-0 bg-background/80 backdrop-blur-xs flex items-center justify-center">
                    <RefreshCw className="w-4 h-4 animate-spin text-primary" />
                  </div>
                )}
              </label>
              {iconUrl && (
                <button
                  type="button"
                  onClick={() => setIconUrl("")}
                  className="text-[10px] text-destructive hover:underline flex items-center gap-0.5 mx-auto"
                >
                  <X className="w-2.5 h-2.5" />
                  <span>清除图标</span>
                </button>
              )}
            </div>

            {/* Platform Name & Short URL note */}
            <div className="space-y-3 flex-1 min-w-0">
              <div className="space-y-1.5">
                <Label htmlFor="pl-name" required>
                  平台名称
                </Label>
                <Input
                  id="pl-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如: 巨量方舟 / 巨量千川"
                  required
                  disabled={loading}
                />
              </div>

              <p className="text-[11px] text-muted-foreground leading-relaxed">
                上传正方形高清图标（PNG/JPG/GIF/WebP/ICO），将同步展示在管理后台及桌面客户端平台快捷列表。
              </p>
            </div>
          </div>

          {/* URL */}
          <div className="space-y-1.5">
            <Label htmlFor="pl-url" required>
              访问网址 (URL)
            </Label>
            <Input
              id="pl-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://agent.oceanengine.com"
              className="font-mono text-xs"
              required
              disabled={loading}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Sort Order */}
            <div className="space-y-1.5">
              <Label htmlFor="pl-sort" required>
                显示排序 (升序)
              </Label>
              <Input
                id="pl-sort"
                type="number"
                min={0}
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
                required
                disabled={loading}
              />
            </div>

            {/* Status */}
            <div className="space-y-1.5">
              <Label htmlFor="pl-status">状态</Label>
              <Select
                value={status}
                onValueChange={(val: "active" | "disabled") => setStatus(val)}
              >
                <SelectTrigger id="pl-status" className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">正常启用（向桌面端分发）</SelectItem>
                  <SelectItem value="disabled">暂时停用（不分发）</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              取消
            </Button>
            <Button type="submit" loading={loading}>
              {isEditing ? "保存平台变更" : "创建平台"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
