import * as React from "react";
import { format, parse, isValid } from "date-fns";
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface DatePickerProps {
  value?: string; // YYYY-MM-DD
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  min?: string;
  max?: string;
  title?: string;
}

export function DatePicker({
  value,
  onChange,
  placeholder = "选择日期",
  className,
  disabled,
  min,
  max,
  title,
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false);

  const selectedDate = React.useMemo(() => {
    if (!value) return null;
    const parsed = parse(value, "yyyy-MM-dd", new Date());
    return isValid(parsed) ? parsed : null;
  }, [value]);

  const [viewDate, setViewDate] = React.useState<Date>(() => selectedDate || new Date());

  React.useEffect(() => {
    if (selectedDate) {
      setViewDate(selectedDate);
    }
  }, [selectedDate]);

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  const prevMonth = () => {
    setViewDate(new Date(year, month - 1, 1));
  };

  const nextMonth = () => {
    setViewDate(new Date(year, month + 1, 1));
  };

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDayOfWeek = new Date(year, month, 1).getDay(); // 0 = Sun, 1 = Mon ...

  // Days array
  const days = React.useMemo(() => {
    const arr: (number | null)[] = [];
    for (let i = 0; i < firstDayOfWeek; i++) {
      arr.push(null);
    }
    for (let i = 1; i <= daysInMonth; i++) {
      arr.push(i);
    }
    return arr;
  }, [firstDayOfWeek, daysInMonth]);

  const isDateDisabled = (day: number) => {
    const dateStr = format(new Date(year, month, day), "yyyy-MM-dd");
    if (min && dateStr < min) return true;
    if (max && dateStr > max) return true;
    return false;
  };

  const handleSelectDay = (day: number) => {
    const formatted = format(new Date(year, month, day), "yyyy-MM-dd");
    onChange(formatted);
    setOpen(false);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange("");
  };

  const isToday = (day: number) => {
    const today = new Date();
    return (
      today.getFullYear() === year &&
      today.getMonth() === month &&
      today.getDate() === day
    );
  };

  const isSelected = (day: number) => {
    if (!selectedDate) return false;
    return (
      selectedDate.getFullYear() === year &&
      selectedDate.getMonth() === month &&
      selectedDate.getDate() === day
    );
  };

  const weekLabels = ["日", "一", "二", "三", "四", "五", "六"];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={title}
          className={cn(
            "flex h-9 w-full items-center justify-between rounded-lg border border-input bg-background px-3 py-1 text-xs text-foreground shadow-xs transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            !value && "text-muted-foreground",
            className
          )}
        >
          <span className="flex items-center gap-2 truncate font-normal">
            <CalendarIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className={cn("truncate", !value && "text-muted-foreground")}>
              {value || placeholder}
            </span>
          </span>
          {value ? (
            <span
              role="button"
              tabIndex={0}
              onClick={handleClear}
              className="ml-1 rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </span>
          ) : null}
        </button>
      </PopoverTrigger>

      <PopoverContent className="w-64 p-3" align="start">
        {/* Calendar Header */}
        <div className="flex items-center justify-between pb-2 mb-2 border-b border-border/60">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={prevMonth}
            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs font-semibold text-foreground">
            {year}年 {month + 1}月
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={nextMonth}
            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        {/* Week Days Header */}
        <div className="grid grid-cols-7 gap-1 text-center mb-1">
          {weekLabels.map((label, idx) => (
            <span
              key={idx}
              className="text-[11px] font-medium text-muted-foreground h-6 flex items-center justify-center"
            >
              {label}
            </span>
          ))}
        </div>

        {/* Days Grid */}
        <div className="grid grid-cols-7 gap-1 text-center">
          {days.map((day, idx) => {
            if (day === null) {
              return <div key={`empty-${idx}`} className="h-7 w-7" />;
            }
            const disabled = isDateDisabled(day);
            const selected = isSelected(day);
            const today = isToday(day);

            return (
              <button
                key={`day-${day}`}
                type="button"
                disabled={disabled}
                onClick={() => handleSelectDay(day)}
                className={cn(
                  "h-7 w-7 rounded-md text-xs flex items-center justify-center transition-colors",
                  selected
                    ? "bg-primary text-primary-foreground font-semibold"
                    : today
                    ? "border border-primary text-primary font-medium hover:bg-accent"
                    : "text-foreground hover:bg-accent",
                  disabled && "opacity-30 cursor-not-allowed hover:bg-transparent"
                )}
              >
                {day}
              </button>
            );
          })}
        </div>

        {/* Footer shortcuts */}
        <div className="flex items-center justify-between pt-2 mt-2 border-t border-border/60 text-[11px]">
          <button
            type="button"
            onClick={() => {
              const today = format(new Date(), "yyyy-MM-dd");
              onChange(today);
              setOpen(false);
            }}
            className="text-primary hover:underline"
          >
            今天
          </button>
          {value && (
            <button
              type="button"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              className="text-muted-foreground hover:text-foreground"
            >
              清空
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
