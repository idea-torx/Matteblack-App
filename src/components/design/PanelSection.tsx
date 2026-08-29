import { useState, useRef, useEffect, type ReactNode } from "react";

interface PanelSectionProps {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
  badge?: ReactNode;
  forceOpen?: boolean;
}

export function PanelSection({ title, defaultOpen = true, children, badge, forceOpen }: PanelSectionProps) {
  const [userToggled, setUserToggled] = useState(false);
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(defaultOpen ? undefined : 0);

  useEffect(() => {
    if (!userToggled) {
      setIsOpen(defaultOpen);
    }
  }, [defaultOpen, userToggled]);

  useEffect(() => {
    if (forceOpen !== undefined) {
      setIsOpen(forceOpen);
      setUserToggled(false);
    }
  }, [forceOpen]);

  useEffect(() => {
    if (!contentRef.current) return;
    if (isOpen) {
      const h = contentRef.current.scrollHeight;
      setHeight(h);
      const timer = setTimeout(() => setHeight(undefined), 200);
      return () => clearTimeout(timer);
    } else {
      setHeight(contentRef.current.scrollHeight);
      requestAnimationFrame(() => {
        setHeight(0);
      });
    }
  }, [isOpen]);

  const handleToggle = () => {
    setUserToggled(true);
    setIsOpen((v) => !v);
  };

  return (
    <div className="panel-section">
      <button
        type="button"
        className="panel-section-header"
        onClick={handleToggle}
      >
        <span className="panel-section-title">{title}</span>
        {badge && <span className="panel-section-badge">{badge}</span>}
        <span className={`panel-section-toggle ${isOpen ? "panel-section-toggle--open" : ""}`}>
          {isOpen ? "−" : "+"}
        </span>
      </button>
      <div
        ref={contentRef}
        className="panel-section-content"
        style={{
          height: height !== undefined ? height : "auto",
          overflow: isOpen && height === undefined ? "visible" : "hidden",
        }}
      >
        <div className="panel-section-inner">
          {children}
        </div>
      </div>
    </div>
  );
}
