export type CatalogRuleOption = {
  id: number;
  name: string;
  priceDelta: number;
  available: boolean;
};

export type CatalogRuleGroup = {
  id: number;
  name: string;
  min: number;
  max: number;
  options: CatalogRuleOption[];
};

export type CatalogSelection = Record<number, number[]>;

export function validateCatalogSelection(groups: CatalogRuleGroup[], selection: CatalogSelection) {
  const errors: string[] = [];

  for (const group of groups) {
    const selectedIds = selection[group.id] ?? [];
    const availableIds = new Set(group.options.filter(option => option.available).map(option => option.id));
    const uniqueIds = new Set(selectedIds);
    const selectedCount = selectedIds.filter(optionId => availableIds.has(optionId)).length;

    if (uniqueIds.size !== selectedIds.length) errors.push(`${group.name}: option dupliquée`);
    if (selectedCount < group.min) errors.push(`${group.name}: sélection obligatoire`);
    if (selectedCount > group.max) errors.push(`${group.name}: trop d'options`);
    if (selectedIds.some(optionId => !availableIds.has(optionId))) errors.push(`${group.name}: option indisponible`);
  }

  return { valid: errors.length === 0, errors };
}

export function calculateCatalogPrice(basePrice: number, groups: CatalogRuleGroup[], selection: CatalogSelection) {
  return basePrice + groups.reduce((total, group) => total + (selection[group.id] ?? []).reduce((groupTotal, optionId) => {
    return groupTotal + (group.options.find(option => option.id === optionId)?.priceDelta ?? 0);
  }, 0), 0);
}

export function getCatalogSelectionLabels(groups: CatalogRuleGroup[], selection: CatalogSelection) {
  return groups.flatMap(group => (selection[group.id] ?? []).map(optionId => {
    const option = group.options.find(entry => entry.id === optionId);
    return option ? `${group.name}: ${option.name}` : null;
  }).filter((label): label is string => Boolean(label)));
}