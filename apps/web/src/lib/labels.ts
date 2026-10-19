import type { Category, Feature, Interest } from "./contracts";

/** Category label fallback (server also sends category_label); icon is a text glyph + label, never colour only. */
export const CATEGORY_META: Record<Category, { label: string; icon: string }> = {
  cafe: { label: "Кафе", icon: "☕" },
  food: { label: "Еда", icon: "🍽" },
  park: { label: "Парк / сквер", icon: "🌳" },
  culture: { label: "Культура", icon: "🏛" },
  attraction: { label: "Достопримечательность", icon: "📍" },
  playground: { label: "Детская площадка", icon: "🛝" },
  mall: { label: "Торговый центр", icon: "🛍" },
};

export const FEATURE_LABEL: Record<Feature, string> = {
  socket: "Розетки",
  wifi: "Wi‑Fi",
  outdoor_seating: "Места на улице",
  wheelchair: "Доступно для колясок",
  indoor: "В помещении",
  kids: "Подходит детям",
};

/** "Наличие розеток не подтверждено" etc. — shown next to the recommendation. */
export const FEATURE_UNKNOWN: Record<Feature, string> = {
  socket: "Наличие розеток не подтверждено",
  wifi: "Наличие Wi‑Fi не подтверждено",
  outdoor_seating: "Места на улице не подтверждены",
  wheelchair: "Доступность для колясок не подтверждена",
  indoor: "Не подтверждено, что место в помещении",
  kids: "Подходит ли детям — не подтверждено",
};

export const FEATURE_NEGATIVE: Record<Feature, string> = {
  socket: "Розеток нет (по данным OSM)",
  wifi: "Wi‑Fi нет (по данным OSM)",
  outdoor_seating: "Мест на улице нет (по данным OSM)",
  wheelchair: "Недоступно для колясок (по данным OSM)",
  indoor: "Не в помещении",
  kids: "Не для детей (по данным OSM)",
};

export const INTEREST_LABEL: Record<Interest, string> = {
  coffee: "Кофе",
  food: "Поесть",
  nature: "Природа",
  culture: "Культура",
  architecture: "Архитектура",
  kids: "С детьми",
  quiet: "Тихо",
  indoor: "В помещении",
  shopping: "Шопинг",
};

/** Hard-condition checkboxes in the optional "Обязательные условия" block. */
export const REQUIRED_FEATURE_OPTIONS: Feature[] = ["socket", "wifi", "indoor", "wheelchair", "kids"];

export const TIME_PRESETS = [20, 40, 60, 90] as const;
export const TIME_MIN = 10;
export const TIME_MAX = 180;
export const QUERY_MAX = 2000;
