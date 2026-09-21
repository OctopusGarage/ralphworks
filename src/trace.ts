import { readFile } from "node:fs/promises";

export type TraceSummary = {
  totalEvents: number;
  eventTypes: string[];
  firstAt?: string;
  lastAt?: string;
};

type TraceEvent = {
  type: string;
  at?: string;
};

export async function readTrace(eventsPath: string): Promise<TraceSummary> {
  const events = (await readFile(eventsPath, "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TraceEvent);

  return {
    totalEvents: events.length,
    eventTypes: events.map((event) => event.type),
    firstAt: events[0]?.at,
    lastAt: events.at(-1)?.at,
  };
}
