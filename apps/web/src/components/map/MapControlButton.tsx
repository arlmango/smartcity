"use client";

interface Props {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  pressed?: boolean;
  disabled?: boolean;
  testId?: string;
}

export function MapControlButton({ label, onClick, children, pressed, disabled, testId }: Props) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
      className="grid h-11 w-11 place-items-center rounded-control border border-stroke bg-white text-xl font-bold text-graphite shadow-control hover:border-graphite/40 disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:bg-graphite aria-pressed:text-white"
    >
      {children}
    </button>
  );
}
