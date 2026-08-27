import React, { useState, useEffect } from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { useTheme, ACCENT_COLOR_PRESETS, AccentColor } from "@/hooks/use-theme";
import {
  Palette,
  Upload,
  RefreshCw,
  Monitor,
  LayoutTemplate,
  Sun,
  Moon,
  Laptop,
  Check,
  Sliders,
  Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  BRAND_IMAGE_ACCEPT,
  requireStoredUploadPath,
  validateBrandImage,
} from "@/lib/upload-paths";

interface LogoUploaderProps {
  label: string;
  value: string;
  onChange: (val: string) => void;
  disabled?: boolean;
}

function LogoUploader({ label, value, onChange, disabled }: LogoUploaderProps) {
  const [isUploading, setIsUploading] = useState(false);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const validationError = validateBrandImage(file);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    setIsUploading(true);
    try {
      const res = await api.uploadFile(file);
      onChange(requireStoredUploadPath(res));
      toast.success(`${label} 上传成功`);
    } catch (error) {
      toast.error(`${label} 上传失败`, {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setIsUploading(false);
      e.target.value = "";
    }
  };

  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-semibold text-foreground">{label}</Label>
      <div>
        {/* Dashed upload square with preview & hover overlay */}
        <label
          className={cn(
            "relative group flex flex-col items-center justify-center w-28 h-28 rounded-2xl border-2 border-dashed transition-all overflow-hidden shrink-0 shadow-2xs select-none",
            disabled || isUploading
              ? "opacity-60 cursor-not-allowed border-muted-foreground/30 bg-muted/20"
              : "cursor-pointer border-primary/40 hover:border-primary bg-slate-50/80 dark:bg-slate-900/40 hover:bg-primary/5 hover:shadow-xs"
          )}
        >
          <input
            type="file"
            accept={BRAND_IMAGE_ACCEPT}
            className="hidden"
            onChange={handleFile}
            disabled={disabled || isUploading}
          />
          {value ? (
            <>
              <img
                src={value}
                alt="Logo Preview"
                className="w-full h-full object-contain p-2.5 transition-transform duration-200 group-hover:scale-105"
              />
              <div className="absolute inset-0 bg-black/50 backdrop-blur-[1px] opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex flex-col items-center justify-center text-white text-[11px] font-medium gap-1.5">
                <Upload className="w-4 h-4" />
                <span>更换图片</span>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center text-slate-400 group-hover:text-primary transition-colors gap-1">
              <Plus className="w-7 h-7 stroke-[1.75]" />
              <span className="text-[10px] font-medium">点击上传</span>
            </div>
          )}
          {isUploading && (
            <div className="absolute inset-0 bg-background/80 backdrop-blur-xs flex items-center justify-center">
              <RefreshCw className="w-5 h-5 animate-spin text-primary" />
            </div>
          )}
        </label>
        <p className="text-[11px] text-muted-foreground mt-1.5">
          支持 PNG、JPG、GIF、WebP、ICO 格式，点击图片可直接更换。
        </p>
      </div>
    </div>
  );
}

export function SettingsView() {
  const {
    theme,
    setTheme,
    accentColor,
    setAccentColor,
    setAdminTitle: setGlobalAdminTitle,
    setAdminLogoUrl: setGlobalAdminLogoUrl,
  } = useTheme();

  // Desktop configuration state
  const [productName, setProductName] = useState("Vestus");
  const [desktopLogoUrl, setDesktopLogoUrl] = useState("");

  // Admin configuration state
  const [adminTitle, setAdminTitle] = useState("Vestus Admin");
  const [adminLogoUrl, setAdminLogoUrl] = useState("");

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchSettings = async () => {
    setLoading(true);
    try {
      const data = await api.getSettings();
      setProductName(data.productName || "Vestus");
      setDesktopLogoUrl(data.logoUrl || "");
      setAdminTitle(data.adminTitle || "Vestus Admin");
      setAdminLogoUrl(data.adminLogoUrl || "");

      // Sync global theme context
      if (data.adminThemeColor && data.adminThemeColor in ACCENT_COLOR_PRESETS) {
        setAccentColor(data.adminThemeColor as AccentColor);
      }
      setGlobalAdminTitle(data.adminTitle || "Vestus Admin");
      setGlobalAdminLogoUrl(data.adminLogoUrl || "");
    } catch {
      toast.error("获取系统配置失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!productName.trim()) {
      toast.error("请输入桌面端产品名称");
      return;
    }
    if (!adminTitle.trim()) {
      toast.error("请输入管理端系统名称");
      return;
    }

    setSaving(true);
    try {
      const updated = await api.updateSettings({
        productName: productName.trim(),
        logoUrl: desktopLogoUrl.trim(),
        adminTitle: adminTitle.trim(),
        adminLogoUrl: adminLogoUrl.trim(),
        adminThemeColor: accentColor,
      });

      // Update global theme context
      setGlobalAdminTitle(updated.adminTitle || "Vestus Admin");
      setGlobalAdminLogoUrl(updated.adminLogoUrl || "");

      toast.success("系统配置已成功保存", {
        description: "管理端外观已即时更新，桌面端重新打开或刷新后将自动同步",
      });
    } catch (err: any) {
      toast.error("保存配置失败", {
        description: err.message || "请稍后重试",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 w-full max-w-5xl pb-10 animate-in fade-in-50 duration-300">
      {/* Top Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-2xl border border-primary/20 bg-gradient-to-r from-primary/5 via-card to-background shadow-xs">
        <div className="flex items-center gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-md shadow-primary/25">
            <Sliders className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold tracking-tight text-foreground">系统全局配置</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              自定义管理端与桌面端的品牌名称、专属 Logo 以及管理后台主题风格配色
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={fetchSettings}
            disabled={loading || saving}
            className="h-9 text-xs gap-1.5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            <span>重新加载</span>
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || loading}
            className="h-9 text-xs px-5 shadow-sm shadow-primary/20"
          >
            {saving ? "正在保存…" : "保存全部配置"}
          </Button>
        </div>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {/* Section 1: Admin Console Configuration */}
        <Card className="border-border/80 shadow-sm overflow-hidden w-full">
          <CardHeader className="border-b bg-muted/20 pb-4">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-lg bg-primary/10 text-primary">
                <LayoutTemplate className="h-4 w-4" />
              </div>
              <div>
                <CardTitle className="text-base">管理端外观与品牌配置</CardTitle>
                <CardDescription className="text-xs text-muted-foreground mt-0.5">
                  配置 Web 管理后台顶栏品牌名称、Logo 图标以及系统主题配色风格
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-6">
            <div className="space-y-6 w-full">
              {/* Admin Title */}
              <div className="space-y-1.5 w-full">
                <Label htmlFor="adminTitle" className="text-xs font-semibold">
                  管理端系统名称 <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="adminTitle"
                  value={adminTitle}
                  onChange={(e) => setAdminTitle(e.target.value)}
                  placeholder="例如：Vestus Admin / 企业控制台"
                  disabled={saving}
                  className="w-full"
                  required
                />
                <p className="text-[11px] text-muted-foreground">
                  显示在管理端侧边栏顶部和浏览器标签页上的名称。
                </p>
              </div>

              {/* Admin Logo Uploader with Dashed Box Preview */}
              <LogoUploader
                label="管理端 Logo 图标"
                value={adminLogoUrl}
                onChange={setAdminLogoUrl}
                disabled={saving}
              />

              {/* Theme Accent Color Selection */}
              <div className="space-y-2 pt-1 w-full">
                <Label className="text-xs font-semibold flex items-center gap-1.5">
                  <Palette className="h-3.5 w-3.5 text-primary" />
                  管理端主题主色调
                </Label>
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-7 gap-3 w-full">
                  {(Object.keys(ACCENT_COLOR_PRESETS) as AccentColor[]).map((key) => {
                    const preset = ACCENT_COLOR_PRESETS[key];
                    const isSelected = accentColor === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setAccentColor(key)}
                        className={cn(
                          "flex flex-col items-center gap-1.5 p-3 rounded-xl border transition-all text-center",
                          isSelected
                            ? "border-primary bg-primary/10 shadow-xs ring-2 ring-primary/30 font-semibold"
                            : "border-border hover:border-border/80 hover:bg-muted/40"
                        )}
                      >
                        <div
                          className="w-5 h-5 rounded-full shadow-xs flex items-center justify-center text-white"
                          style={{ backgroundColor: preset.colorHex }}
                        >
                          {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                        </div>
                        <span className="text-[11px] font-medium text-foreground">{preset.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Light / Dark Mode Selection */}
              <div className="space-y-2 pt-1 w-full">
                <Label className="text-xs font-semibold flex items-center gap-1.5">
                  <Sun className="h-3.5 w-3.5 text-primary" />
                  管理端明暗模式
                </Label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full sm:max-w-xl">
                  <button
                    type="button"
                    onClick={() => setTheme("light")}
                    className={cn(
                      "flex items-center justify-center gap-2 p-3 rounded-xl border transition-all text-xs font-medium",
                      theme === "light"
                        ? "border-primary bg-primary/10 text-primary font-semibold ring-2 ring-primary/30 shadow-xs"
                        : "border-border hover:border-border/80 hover:bg-muted/40 text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Sun className="h-4 w-4 text-amber-500 shrink-0" />
                    <span>明亮模式</span>
                    {theme === "light" && <Check className="w-3.5 h-3.5 ml-auto text-primary stroke-[3]" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setTheme("dark")}
                    className={cn(
                      "flex items-center justify-center gap-2 p-3 rounded-xl border transition-all text-xs font-medium",
                      theme === "dark"
                        ? "border-primary bg-primary/10 text-primary font-semibold ring-2 ring-primary/30 shadow-xs"
                        : "border-border hover:border-border/80 hover:bg-muted/40 text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Moon className="h-4 w-4 text-sky-400 shrink-0" />
                    <span>暗黑模式</span>
                    {theme === "dark" && <Check className="w-3.5 h-3.5 ml-auto text-primary stroke-[3]" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setTheme("system")}
                    className={cn(
                      "flex items-center justify-center gap-2 p-3 rounded-xl border transition-all text-xs font-medium",
                      theme === "system"
                        ? "border-primary bg-primary/10 text-primary font-semibold ring-2 ring-primary/30 shadow-xs"
                        : "border-border hover:border-border/80 hover:bg-muted/40 text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Laptop className="h-4 w-4 text-slate-400 shrink-0" />
                    <span>跟随系统</span>
                    {theme === "system" && <Check className="w-3.5 h-3.5 ml-auto text-primary stroke-[3]" />}
                  </button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Section 2: Desktop Client Configuration */}
        <Card className="border-border/80 shadow-sm overflow-hidden w-full">
          <CardHeader className="border-b bg-muted/20 pb-4">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-lg bg-primary/10 text-primary">
                <Monitor className="h-4 w-4" />
              </div>
              <div>
                <CardTitle className="text-base">桌面客户端品牌配置</CardTitle>
                <CardDescription className="text-xs text-muted-foreground mt-0.5">
                  配置桌面客户端软件名称、Logo 图标及登录页品牌展示
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-6">
            <div className="space-y-6 w-full">
              {/* Desktop Product Name */}
              <div className="space-y-1.5 w-full">
                <Label htmlFor="productName" className="text-xs font-semibold">
                  桌面端产品名称 <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="productName"
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  placeholder="例如：Vestus / 极速代理浏览器"
                  disabled={saving}
                  className="w-full"
                  required
                />
                <p className="text-[11px] text-muted-foreground">
                  桌面客户端标题栏、登录页居中标题及侧边栏品牌名称。
                </p>
              </div>

              {/* Desktop Logo Uploader with Dashed Box Preview */}
              <LogoUploader
                label="桌面端 Logo 图标"
                value={desktopLogoUrl}
                onChange={setDesktopLogoUrl}
                disabled={saving}
              />
            </div>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}
