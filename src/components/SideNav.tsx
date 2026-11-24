"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, Plane, Radar, ShieldCheck, Siren, Ticket, Waypoints } from "lucide-react";
import { cx } from "./ui";

const GROUPS = [
  [
    { href: "/", label: "Book a flight", icon: Plane },
    { href: "/mandate", label: "My mandate", icon: ShieldCheck },
    { href: "/search", label: "Agent search", icon: Radar },
    { href: "/checkout", label: "Gate check", icon: Waypoints },
    { href: "/ticket", label: "E-ticket", icon: Ticket },
  ],
  [
    { href: "/drill", label: "Breach drill", icon: Siren },
    { href: "/#how", label: "How it works", icon: BookOpen },
  ],
];

/** Left rail like an OTA home page; each entry is one stop of the demo. */
export function SideNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Sections" className="sticky top-24 space-y-3">
      {GROUPS.map((group, gi) => (
        <ul key={gi} className={cx("space-y-1", gi > 0 && "border-t border-line pt-3")}>
          {group.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={cx(
                    "flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] font-medium transition",
                    active ? "bg-brand-50 text-brand" : "text-ink hover:bg-white",
                  )}
                >
                  <Icon className="size-5" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      ))}
    </nav>
  );
}
