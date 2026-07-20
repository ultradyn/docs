import {
  AudioLines,
  CircleHelp,
  ClipboardList,
  Library,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { NavLink } from "react-router-dom";

interface NavigationProps {
  maintenanceEnabled: boolean;
}

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

export function Navigation({ maintenanceEnabled }: NavigationProps) {
  const items: NavItem[] = [
    { to: "/ask", label: "Ask", icon: CircleHelp },
    { to: "/queue", label: "Queue", icon: ClipboardList },
    { to: "/answer", label: "Answer", icon: AudioLines },
    { to: "/ingest", label: "Sources", icon: Library },
    { to: "/settings", label: "Settings", icon: Settings },
  ];
  if (maintenanceEnabled)
    items.push({ to: "/maintenance", label: "Maintenance", icon: ShieldCheck });

  return (
    <nav className="navigation" aria-label="Primary">
      {items.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          aria-label={label}
          title={label}
          className={({ isActive }) =>
            `nav-link${isActive ? " nav-link-active" : ""}`
          }
        >
          <Icon aria-hidden="true" size={19} strokeWidth={1.8} />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
