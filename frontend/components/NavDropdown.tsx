"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export interface NavDropdownItem {
  href: string;
  label: React.ReactNode;
  external?: boolean;
}

/**
 * Click-to-toggle dropdown for navbar groups. Works the same on desktop
 * and touch: tap the label to open, tap an item (or outside, or Escape)
 * to close. No hover-only behavior so phone users are never stuck.
 */
export default function NavDropdown({
  label,
  items,
}: {
  label: React.ReactNode;
  items: NavDropdownItem[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open ]);

  const itemStyle: React.CSSProperties = {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "10px 14px",
    fontSize: 14,
    textDecoration: "none",
    boxSizing: "border-box",
  };

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        className="vs-btn vs-btn-ghost"
        style={{ padding: "8px 20px", fontSize: 14 }}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label}{" "}
        <span aria-hidden="true" style={{ fontSize: 11 }}>
          ▾
        </span>
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            minWidth: 210,
            background: "rgba(13,16,26,0.97)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 12,
            padding: 6,
            boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
            zIndex: 60,
          }}
        >
          {items.map((item) =>
            item.external ? (
              <a
                key={item.href}
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="vs-btn vs-btn-ghost"
                style={itemStyle}
              >
                {item.label}
              </a>
            ) : (
              <Link
                key={item.href}
                href={item.href}
                role="menuitem"
                onClick={() => setOpen(false)}
                className="vs-btn vs-btn-ghost"
                style={itemStyle}
              >
                {item.label}
              </Link>
            )
          )}
        </div>
      )}
    </div>
  );
}
