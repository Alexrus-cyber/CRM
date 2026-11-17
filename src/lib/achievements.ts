export type UserStats = {
  created: number;
  completed: number;
  onTime: number;
  late: number;
  hours: number;
  messages: number;
  criticalDone: number;
  closedByMe: number;
};

export type AchievementDef = {
  id: string;
  title: string;
  description: string;
  image: string;
  points: number;
  tier: 1 | 2 | 3;
  target: number;
  value: (s: UserStats) => number;
  extra?: (s: UserStats) => boolean;
};

export type AchievementResult = AchievementDef & {
  unlocked: boolean;
  current: number;
  progress: number; // 0..1
};

export const ACHIEVEMENTS: AchievementDef[] = [
  {
    id: "first_task",
    title: "Первый шаг",
    description: "Поставить первую задачу",
    image: "/achievements/creator.webp",
    points: 10,
    tier: 1,
    target: 1,
    value: (s) => s.created,
  },
  {
    id: "taskmaster",
    title: "Постановщик",
    description: "Поставить 10 задач команде",
    image: "/achievements/creator.webp",
    points: 30,
    tier: 2,
    target: 10,
    value: (s) => s.created,
  },
  {
    id: "architect",
    title: "Архитектор задач",
    description: "Поставить 50 задач",
    image: "/achievements/creator.webp",
    points: 100,
    tier: 3,
    target: 50,
    value: (s) => s.created,
  },
  {
    id: "first_done",
    title: "Исполнитель",
    description: "Выполнить первую задачу",
    image: "/achievements/executor.webp",
    points: 10,
    tier: 1,
    target: 1,
    value: (s) => s.completed,
  },
  {
    id: "master",
    title: "Мастер",
    description: "Выполнить 10 задач",
    image: "/achievements/executor.webp",
    points: 40,
    tier: 2,
    target: 10,
    value: (s) => s.completed,
  },
  {
    id: "legend",
    title: "Легенда команды",
    description: "Выполнить 50 задач",
    image: "/achievements/legend.webp",
    points: 150,
    tier: 3,
    target: 50,
    value: (s) => s.completed,
  },
  {
    id: "on_time_5",
    title: "Точно в срок",
    description: "Выполнить 5 задач без просрочки",
    image: "/achievements/ontime.webp",
    points: 30,
    tier: 2,
    target: 5,
    value: (s) => s.onTime,
  },
  {
    id: "sniper",
    title: "Снайпер дедлайнов",
    description: "20 задач в срок и ни одной просрочки",
    image: "/achievements/ontime.webp",
    points: 120,
    tier: 3,
    target: 20,
    value: (s) => s.onTime,
    extra: (s) => s.late === 0,
  },
  {
    id: "firefighter",
    title: "Пожарный",
    description: "Выполнить 5 критических задач",
    image: "/achievements/legend.webp",
    points: 60,
    tier: 2,
    target: 5,
    value: (s) => s.criticalDone,
  },
  {
    id: "marathon",
    title: "Марафонец",
    description: "Закрыть задач на 100 часов работы",
    image: "/achievements/marathon.webp",
    points: 80,
    tier: 3,
    target: 100,
    value: (s) => s.hours,
  },
  {
    id: "closer",
    title: "Контролёр",
    description: "Закрыть 10 задач как постановщик",
    image: "/achievements/executor.webp",
    points: 40,
    tier: 2,
    target: 10,
    value: (s) => s.closedByMe,
  },
  {
    id: "team_player",
    title: "Душа команды",
    description: "Написать 25 сообщений в чате",
    image: "/achievements/team.webp",
    points: 25,
    tier: 1,
    target: 25,
    value: (s) => s.messages,
  },
];

export function computeAchievements(stats: UserStats): AchievementResult[] {
  return ACHIEVEMENTS.map((a) => {
    const current = a.value(stats);
    const unlocked = current >= a.target && (a.extra ? a.extra(stats) : true);
    const progress = Math.min(1, a.target === 0 ? 1 : current / a.target);
    return { ...a, unlocked, current, progress };
  });
}

export function achievementPoints(list: AchievementResult[]) {
  return list.filter((a) => a.unlocked).reduce((s, a) => s + a.points, 0);
}

export function emptyStats(): UserStats {
  return {
    created: 0,
    completed: 0,
    onTime: 0,
    late: 0,
    hours: 0,
    messages: 0,
    criticalDone: 0,
    closedByMe: 0,
  };
}
