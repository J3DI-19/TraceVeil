import type { ReactNode } from "react";
import type { Severity } from "../../types/domain";

export function Panel({ children, className = "", title, action }: { children: ReactNode; className?: string; title?: string; action?: ReactNode }) {
  return <section className={`panel ${className}`}>{title && <div className="panel-head"><div><span className="eyebrow">Investigation view</span><h3>{title}</h3></div>{action}</div>}{children}</section>;
}
export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description: string; actions?: ReactNode }) {
  return <div className="page-header"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1><p>{description}</p></div>{actions && <div className="page-actions">{actions}</div>}</div>;
}
export function MetricCard({ label, value, detail, trend, tone = "default", icon }: { label: string; value: string | number; detail?: string; trend?: string; tone?: "default" | "danger" | "cyan"; icon?: string }) {
  return <div className={`metric-card metric-${tone}`}><div className="metric-top"><span>{label}</span>{icon && <span className="metric-icon">{icon}</span>}</div><strong>{value}</strong><div className="metric-foot">{trend && <span className="trend">{trend}</span>}<span>{detail}</span></div></div>;
}
export function SeverityBadge({ severity }: { severity: Severity }) { return <span className={`badge severity-${severity.toLowerCase()}`}>{severity}</span>; }
export function RiskBadge({ score }: { score: number }) { const band = score >= 80 ? "critical" : score >= 60 ? "high" : score >= 40 ? "medium" : "low"; return <span className={`risk-badge risk-${band}`}><i />{score} risk</span>; }
export function StatusBadge({ status }: { status: string }) { return <span className={`status-badge status-${status.toLowerCase().replace(/\s/g,"-")}`}><i />{status}</span>; }
export function Button({ children, variant = "secondary", onClick, type = "button", disabled = false, title }: { children: ReactNode; variant?: "primary" | "secondary" | "ghost" | "danger"; onClick?: () => void; type?: "button" | "submit"; disabled?: boolean; title?: string }) { return <button className={`button button-${variant}`} onClick={onClick} type={type} disabled={disabled} title={title}>{children}</button>; }
export function Input({ placeholder, value, onChange, ariaLabel }: { placeholder?: string; value?: string; onChange?: (v: string) => void; ariaLabel?: string }) { return <input className="input" placeholder={placeholder} value={value} onChange={e => onChange?.(e.target.value)} aria-label={ariaLabel || placeholder} />; }
export function Select({ children, value, onChange, ariaLabel }: { children: ReactNode; value?: string; onChange?: (v: string) => void; ariaLabel?: string }) { return <select className="select" value={value} onChange={e => onChange?.(e.target.value)} aria-label={ariaLabel}>{children}</select>; }
export function EmptyState({ title, description, action, className = "" }: { title: string; description: string; action?: ReactNode; className?: string }) {
  return <div className={["empty-state", className].filter(Boolean).join(" ")}><div className="empty-state__content"><span className="empty-state__icon" aria-hidden="true">◇</span><h3>{title}</h3><p>{description}</p>{action}</div></div>;
}
