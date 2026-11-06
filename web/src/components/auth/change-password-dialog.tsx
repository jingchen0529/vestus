import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { validateChangePassword, type ChangePasswordFields } from "./change-password-form";

const emptyFields: ChangePasswordFields = { currentPassword: "", newPassword: "", confirmPassword: "" };
const passwordFields = [
  { name: "currentPassword", label: "当前密码", autoComplete: "current-password" },
  { name: "newPassword", label: "新密码", autoComplete: "new-password" },
  { name: "confirmPassword", label: "确认新密码", autoComplete: "new-password" },
] as const;

interface ChangePasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChangePasswordDialog({ open, onOpenChange }: ChangePasswordDialogProps) {
  const { changePassword, isSuperAdmin } = useAuth();
  const id = useId();
  const [fields, setFields] = useState(emptyFields);
  const [visibleFields, setVisibleFields] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);

  useEffect(() => {
    if (!open) {
      setFields(emptyFields);
      setVisibleFields([]);
      setError(null);
    }
  }, [open]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!submitting.current) onOpenChange(nextOpen);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current || !isSuperAdmin) return;
    const validationError = validateChangePassword(fields);
    setError(validationError);
    if (validationError) return;

    submitting.current = true;
    setPending(true);
    try {
      await changePassword({ currentPassword: fields.currentPassword, newPassword: fields.newPassword });
      onOpenChange(false);
      toast.success("密码修改成功，请重新登录");
    } catch (err) {
      setError(err instanceof Error ? err.message : "修改密码失败，请稍后重试");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  if (!isSuperAdmin) return null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>修改密码</DialogTitle>
          <DialogDescription>修改成功后将退出当前会话，请使用新密码重新登录。</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate className="space-y-4" aria-busy={pending}>
          {passwordFields.map(({ name, label, autoComplete }) => {
            const visible = visibleFields.includes(name);
            return (
              <div key={name} className="space-y-2">
                <Label htmlFor={`${id}-${name}`}>{label}</Label>
                <div className="relative">
                  <Input
                    id={`${id}-${name}`}
                    name={name}
                    type={visible ? "text" : "password"}
                    autoComplete={autoComplete}
                    value={fields[name]}
                    onChange={(event) => setFields({ ...fields, [name]: event.target.value })}
                    required
                    minLength={name === "newPassword" ? 6 : undefined}
                    maxLength={name === "currentPassword" ? undefined : 256}
                    disabled={pending}
                    aria-describedby={error ? `${id}-error` : undefined}
                    className="pr-11"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-0 top-0 h-full w-10"
                    aria-label={`${visible ? "隐藏" : "显示"}${label}`}
                    aria-pressed={visible}
                    disabled={pending}
                    onClick={() => setVisibleFields((current) => visible ? current.filter((field) => field !== name) : [...current, name])}
                  >
                    {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            );
          })}
          <p className="text-xs text-muted-foreground">新密码须为 6–256 位，且不能与当前密码相同。</p>
          {error && <p id={`${id}-error`} role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => handleOpenChange(false)}>取消</Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {pending ? "正在修改…" : "确认修改"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
