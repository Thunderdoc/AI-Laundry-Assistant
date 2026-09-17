import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

type RevealProps = {
  children: ReactNode;
  className?: string;
  delay?: number;
  as?: "div" | "section" | "aside";
  "aria-labelledby"?: string;
};

export function Reveal({ children, className, delay = 0, as = "div", ...rest }: RevealProps) {
  const reduceMotion = useReducedMotion();
  const Component = motion[as];
  return (
    <Component
      className={className}
      {...rest}
      initial={reduceMotion ? false : { opacity: 0, y: 18 }}
      whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: 0.55, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </Component>
  );
}

export function TextEffect({ children, className }: { children: string; className?: string }) {
  const reduceMotion = useReducedMotion();
  const words = children.split(" ");
  if (reduceMotion) return <span className={className}>{children}</span>;
  return (
    <motion.span className={className} initial="hidden" animate="visible" variants={{ visible: { transition: { staggerChildren: 0.055 } } }}>
      {words.map((word, index) => (
        <motion.span className="motion-word" key={`${word}-${index}`} variants={{ hidden: { opacity: 0, y: 22 }, visible: { opacity: 1, y: 0, transition: { duration: 0.52, ease: [0.22, 1, 0.36, 1] } } }}>
          {word}{index < words.length - 1 ? "\u00a0" : ""}
        </motion.span>
      ))}
    </motion.span>
  );
}

export function MotionPanel({ panelKey, children, className }: { panelKey: string; children: ReactNode; className?: string }) {
  const reduceMotion = useReducedMotion();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={panelKey}
        className={className}
        initial={reduceMotion ? false : { opacity: 0, x: 12, scale: 0.995 }}
        animate={{ opacity: 1, x: 0, scale: 1 }}
        exit={reduceMotion ? undefined : { opacity: 0, x: -8, scale: 0.995 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

export const MotionButton = motion.button;
export const MotionDiv = motion.div;
export const MotionMain = motion.main;
export const MotionSection = motion.section;

export function MotionPage({ children, className }: { children: ReactNode; className?: string }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.main
      className={className}
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: .32, ease: "easeOut" }}
    >
      {children}
    </motion.main>
  );
}
