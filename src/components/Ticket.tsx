import type { ReactNode } from "react";
import s from "./Ticket.module.css";

export const Ticket = ({ children, stub = "Admit one", torn = false }: { children: ReactNode; stub?: string; torn?: boolean }) => (
  <div className={`${s.ticket} ${torn ? s.torn : ""}`}>
    <div className={s.body}>{children}</div>
    <div className={s.stub}>{stub}</div>
  </div>
);
