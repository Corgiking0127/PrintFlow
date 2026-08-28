export type Project = {
  id: string;
  name: string;
  sourceUrl: string;
  plates: number;
  durationMinutes: number;
  plateDurations?: number[];
  plateNames?: string[];
  splitByPlate?: boolean;
  urgent: boolean;
  deadline: string | null;
  material: string;
  color: string;
  status: string;
  createdAt?: string;
};

export type ScheduleSettings = {
  weekdayMorning: string;
  weekdayNoon: string;
  weekdayEvening: string;
  weekend: string;
  reminderMinutes: number;
  overdueMinutes: number;
  autoReschedule: boolean;
  failureBuffer: number;
  barkKey: string;
};

export type ScheduledPlate = {
  id: string;
  projectId: string;
  projectName: string;
  plate: number;
  plateCount: number;
  plateName: string;
  planningUnit: "project" | "plate";
  durationMinutes: number;
  start: Date;
  end: Date;
  nextAvailable: Date;
  idleMinutes: number;
  urgent: boolean;
  deadline: string | null;
  material: string;
  tone: "live" | "night" | "urgent" | "day";
};

function parseWindow(value: string) {
  const [from = "08:00", to = "23:30"] = value.split("-");
  const [fromH, fromM] = from.split(":").map(Number);
  const [toH, toM] = to.split(":").map(Number);
  return { start: fromH * 60 + fromM, end: toH * 60 + toM };
}

function windowsFor(date: Date, settings: ScheduleSettings) {
  const day = date.getDay();
  return day === 0 || day === 6
    ? [parseWindow(settings.weekend)]
    : [parseWindow(settings.weekdayMorning), parseWindow(settings.weekdayNoon), parseWindow(settings.weekdayEvening)];
}

function minuteOfDay(date: Date) {
  return date.getHours() * 60 + date.getMinutes();
}

function isChangeAvailable(date: Date, settings: ScheduleSettings) {
  const minute = minuteOfDay(date);
  return windowsFor(date, settings).some((window) => minute >= window.start && minute <= window.end);
}

export function nextChangeTime(input: Date, settings: ScheduleSettings) {
  const date = new Date(input);
  date.setSeconds(0, 0);
  for (let dayOffset = 0; dayOffset < 10; dayOffset += 1) {
    const candidateDay = new Date(date);
    candidateDay.setDate(date.getDate() + dayOffset);
    for (const window of windowsFor(candidateDay, settings)) {
      const candidate = new Date(candidateDay);
      candidate.setHours(Math.floor(window.start / 60), window.start % 60, 0, 0);
      if (candidate >= date) return candidate;
      const end = new Date(candidateDay);
      end.setHours(Math.floor(window.end / 60), window.end % 60, 0, 0);
      if (date <= end && isChangeAvailable(date, settings)) return new Date(date);
    }
  }
  return date;
}

function deadlinePressure(project: Project, end: Date) {
  if (!project.deadline) return 0;
  const remaining = new Date(project.deadline).getTime() - end.getTime();
  if (remaining <= 0) return 9000 + Math.min(3000, Math.abs(remaining) / 60000);
  const hours = remaining / 3600000;
  return Math.max(0, 3600 - hours * 90);
}

export function buildSchedule(projects: Project[], settings: ScheduleSettings, startAt = new Date()) {
  const plates = projects
    .filter((project) => project.status !== "complete")
    .flatMap((project) => {
      const plateCount = Math.max(1, project.plates);
      if (!project.splitByPlate) {
        return [{ project, plate: 0, plateName: "整项目", duration: Math.max(15, project.durationMinutes), planningUnit: "project" as const }];
      }
      const average = Math.max(15, Math.ceil(project.durationMinutes / plateCount));
      return Array.from({ length: plateCount }, (_, index) => ({
        project,
        plate: index + 1,
        plateName: project.plateNames?.[index] || `打印盘 ${index + 1}`,
        duration: Math.max(15, project.plateDurations?.[index] || average),
        planningUnit: "plate" as const,
      }));
    });

  const scheduled: ScheduledPlate[] = [];
  let cursor = new Date(startAt);
  cursor.setSeconds(0, 0);
  const pending = [...plates];

  while (pending.length) {
    const ranked = pending.map((item, index) => {
      const end = new Date(cursor.getTime() + item.duration * 60000);
      const change = isChangeAvailable(end, settings) ? end : nextChangeTime(end, settings);
      const idle = Math.max(0, Math.round((change.getTime() - end.getTime()) / 60000));
      const night = cursor.getHours() >= 18 || cursor.getHours() < 7;
      const nightFit = night && item.duration >= 300 ? 1400 : 0;
      const daytimeShort = !night && item.duration <= 210 ? 500 : 0;
      const score = (item.project.urgent ? 12000 : 0) + deadlinePressure(item.project, end) + nightFit + daytimeShort - idle * 4 - index;
      return { ...item, index, end, change, idle, score };
    }).sort((a, b) => b.score - a.score);

    const chosen = ranked[0];
    pending.splice(chosen.index, 1);
    const night = cursor.getHours() >= 18 || cursor.getHours() < 7;
    scheduled.push({
      id: `${chosen.project.id}-${chosen.planningUnit === "project" ? "project" : chosen.plate}`,
      projectId: chosen.project.id,
      projectName: chosen.project.name,
      plate: chosen.plate,
      plateCount: chosen.project.plates,
      plateName: chosen.plateName,
      planningUnit: chosen.planningUnit,
      durationMinutes: chosen.duration,
      start: new Date(cursor),
      end: chosen.end,
      nextAvailable: chosen.change,
      idleMinutes: chosen.idle,
      urgent: chosen.project.urgent,
      deadline: chosen.project.deadline,
      material: chosen.project.material,
      tone: chosen.project.urgent || chosen.project.deadline ? "urgent" : night && chosen.duration >= 240 ? "night" : scheduled.length === 0 ? "live" : "day",
    });
    cursor = chosen.change;
  }

  return scheduled;
}

export function durationLabel(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours ? `${hours}h ` : ""}${mins ? `${mins}m` : ""}`.trim();
}

export function timeLabel(date: Date) {
  const today = new Date();
  const day = date.toDateString() === today.toDateString() ? "" : `${date.getMonth() + 1}/${date.getDate()} `;
  return `${day}${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
