export type ToolResult<T = unknown> =
  | {
      success: true;
      data: T;
      message?: string;
    }
  | {
      success: false;
      errorCode: string;
      message: string;
      retryable: boolean;
    };

export type CatalogOption = {
  id: number;
  name: string;
  priceDelta: number;
  price?: number;
  priceDeltaBySize?: Record<string, number>;
  availableFor?: string[];
  available: boolean;
};

export type CatalogOptionGroup = {
  id: number;
  name: string;
  min: number;
  max: number;
  required?: boolean;
  rulesBySize?: Record<string, { required: boolean; min: number; max: number }>;
  options: CatalogOption[];
};

export type CatalogProduct = {
  productId: string;
  name: string;
  detail: string;
  price: number;
  available: boolean;
  optionGroups?: CatalogOptionGroup[];
};

export type OrderSelection = {
  group: string;
  options: string[];
};

export type UpdateOrderArguments = {
  items: Array<{
    product_id: string;
    quantity: number;
    selections?: OrderSelection[];
  }>;
  status: 'editing' | 'ready_to_confirm' | 'confirmed';
};

export type BasketItem = {
  id: string;
  productId: string;
  name: string;
  detail: string;
  price: number;
  quantity: number;
  customizations: string[];
};

export type BasketSnapshot = {
  restaurantId: string;
  items: BasketItem[];
  total: number;
  status: UpdateOrderArguments['status'];
  submittedOrderId?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const errorResult = (errorCode: string, message: string, retryable = false): ToolResult<never> => ({
  success: false,
  errorCode,
  message,
  retryable,
});

export function parseUpdateOrderArguments(rawArguments: string): ToolResult<UpdateOrderArguments> {
  let value: unknown;
  try {
    value = JSON.parse(rawArguments);
  } catch {
    return errorResult('INVALID_JSON', 'Les arguments du panier ne sont pas un JSON valide. Demande au client de préciser sa commande.');
  }

  if (!isRecord(value) || !Array.isArray(value.items) || !['editing', 'ready_to_confirm', 'confirmed'].includes(String(value.status))) {
    return errorResult('INVALID_ARGUMENTS', 'Les arguments du panier sont incomplets. Demande au client de préciser les articles et leur état.');
  }

  const items: UpdateOrderArguments['items'] = [];
  for (const rawItem of value.items) {
    if (!isRecord(rawItem) || typeof rawItem.product_id !== 'string' || !rawItem.product_id.trim()) {
      return errorResult('INVALID_ARGUMENTS', 'Un article du panier ne possède pas d’identifiant produit valide.');
    }
    if (!Number.isInteger(rawItem.quantity) || Number(rawItem.quantity) < 1 || Number(rawItem.quantity) > 20) {
      return errorResult('INVALID_QUANTITY', 'La quantité doit être un nombre entier compris entre 1 et 20.');
    }

    let selections: OrderSelection[] | undefined;
    if (rawItem.selections !== undefined) {
      if (!Array.isArray(rawItem.selections)) {
        return errorResult('INVALID_ARGUMENTS', 'Les options du produit sont invalides.');
      }
      selections = [];
      for (const rawSelection of rawItem.selections) {
        if (!isRecord(rawSelection) || typeof rawSelection.group !== 'string' || !rawSelection.group.trim() || !Array.isArray(rawSelection.options) || rawSelection.options.some(option => typeof option !== 'string')) {
          return errorResult('INVALID_ARGUMENTS', 'Un groupe d’options est invalide.');
        }
        selections.push({
          group: rawSelection.group.trim(),
          options: rawSelection.options.map(option => option.trim()).filter(Boolean),
        });
      }
    }

    items.push({
      product_id: rawItem.product_id.trim(),
      quantity: Number(rawItem.quantity),
      ...(selections ? { selections } : {}),
    });
  }

  return {
    success: true,
    data: {
      items,
      status: value.status as UpdateOrderArguments['status'],
    },
  };
}

function normalizeCatalogProduct(value: unknown): CatalogProduct | null {
  if (!isRecord(value) || typeof value.productId !== 'string' || typeof value.name !== 'string') return null;
  const price = Number(value.price);
  if (!Number.isFinite(price) || price < 0) return null;
  const rawGroups = Array.isArray(value.optionGroups) ? value.optionGroups : [];
  const optionGroups = rawGroups.flatMap((rawGroup): CatalogOptionGroup[] => {
    if (!isRecord(rawGroup) || typeof rawGroup.name !== 'string' || !Array.isArray(rawGroup.options)) return [];
    const options = rawGroup.options.flatMap((rawOption, optionIndex): CatalogOption[] => {
      if (!isRecord(rawOption) || typeof rawOption.name !== 'string') return [];
      const optionId = Number(rawOption.id);
      const priceDelta = Number(rawOption.priceDelta ?? 0);
      const priceDeltaBySize = isRecord(rawOption.priceDeltaBySize)
        ? Object.fromEntries(Object.entries(rawOption.priceDeltaBySize).flatMap(([size, delta]) => {
          const numericDelta = Number(delta);
          return Number.isFinite(numericDelta) ? [[size, numericDelta]] : [];
        }))
        : undefined;
      return [{
        id: Number.isFinite(optionId) ? optionId : optionIndex + 1,
        name: rawOption.name,
        priceDelta: Number.isFinite(priceDelta) ? priceDelta : 0,
        ...(priceDeltaBySize ? { priceDeltaBySize } : {}),
        ...(Array.isArray(rawOption.availableFor)
          ? { availableFor: rawOption.availableFor.filter((size): size is string => typeof size === 'string') }
          : {}),
        available: rawOption.available !== false,
      }];
    });
    const required = rawGroup.required === true;
    const rawMin = Number(rawGroup.min ?? (required ? 1 : 0));
    const min = Math.max(0, Math.trunc(Number.isFinite(rawMin) ? rawMin : required ? 1 : 0));
    const rawMax = Number(rawGroup.max ?? Math.max(min, options.length));
    const max = Math.max(min, Math.trunc(Number.isFinite(rawMax) ? rawMax : Math.max(min, options.length)));
    const rulesBySize = isRecord(rawGroup.rulesBySize)
      ? Object.fromEntries(Object.entries(rawGroup.rulesBySize).flatMap(([size, rawRule]) => {
        if (!isRecord(rawRule)) return [];
        const ruleRequired = rawRule.required === true;
        const ruleMinValue = Number(rawRule.min ?? (ruleRequired ? 1 : 0));
        const ruleMin = Math.max(0, Math.trunc(Number.isFinite(ruleMinValue) ? ruleMinValue : ruleRequired ? 1 : 0));
        const ruleMaxValue = Number(rawRule.max ?? Math.max(ruleMin, options.length));
        const ruleMax = Math.max(ruleMin, Math.trunc(Number.isFinite(ruleMaxValue) ? ruleMaxValue : Math.max(ruleMin, options.length)));
        return [[size, { required: ruleRequired, min: ruleMin, max: ruleMax }]];
      }))
      : undefined;
    return [{
      id: Number(rawGroup.id) || 0,
      name: rawGroup.name,
      min,
      max,
      required,
      ...(rulesBySize ? { rulesBySize } : {}),
      options,
    }];
  });

  return {
    productId: value.productId,
    name: value.name,
    detail: typeof value.detail === 'string' ? value.detail : '',
    price,
    available: value.available !== false,
    optionGroups,
  };
}

export function normalizeCatalog(value: unknown): CatalogProduct[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const product = normalizeCatalogProduct(entry);
    return product ? [product] : [];
  });
}

const sizeMatches = (configuredSize: string, selectedSize: string) => {
  const aliasesBySelectedSize: Record<string, string[]> = {
    Medium: ['Medium', 'M'],
    'King Size': ['King Size', 'King', 'L', 'XL'],
    Extra: ['Extra', 'XXL', 'XL'],
  };
  const aliases = Object.entries(aliasesBySelectedSize).find(([size]) => size.toLowerCase() === selectedSize.toLowerCase())?.[1] ?? [selectedSize];
  return aliases.some(alias => alias.toLowerCase() === configuredSize.toLowerCase());
};

function resolveSelections(product: CatalogProduct, selections: OrderSelection[] | undefined): ToolResult<{ labels: string[]; priceDelta: number }> {
  const groups = product.optionGroups ?? [];
  const provided = selections ?? [];
  const labels: string[] = [];
  const providedGroupNames = provided.map(selection => selection.group.toLowerCase());
  if (new Set(providedGroupNames).size !== providedGroupNames.length) {
    return errorResult('INVALID_OPTIONS', 'Un même groupe d’options a été envoyé plusieurs fois.');
  }

  const sizeGroup = groups.find(group => /taille/i.test(group.name));
  const sizeSelection = sizeGroup && provided.find(selection => selection.group.toLowerCase() === sizeGroup.name.toLowerCase());
  const selectedSize = sizeSelection?.options[0];
  if (sizeGroup && (!sizeSelection || sizeSelection.options.length !== 1)) {
    return errorResult('REQUIRED_OPTIONS_MISSING', 'La taille du menu doit être choisie.');
  }
  let priceDelta = 0;

  for (const group of groups) {
    const selection = provided.find(entry => entry.group.toLowerCase() === group.name.toLowerCase());
    const selectedNames = selection?.options ?? [];
    const uniqueNames = new Set(selectedNames.map(name => name.toLowerCase()));
    if (uniqueNames.size !== selectedNames.length) {
      return errorResult('INVALID_OPTIONS', `Le groupe « ${group.name} » contient une option dupliquée.`);
    }
    const selectedOptions = selectedNames.map(optionName => group.options.find(option => option.name.toLowerCase() === optionName.toLowerCase()));
    const unavailableOption = selectedOptions.some(option =>
      !option
      || !option.available
      || (Boolean(selectedSize) && option.availableFor !== undefined && !option.availableFor.some(size => sizeMatches(size, selectedSize!))),
    );
    if (unavailableOption) {
      return errorResult('OPTION_UNAVAILABLE', `Une option du groupe « ${group.name} » n’est pas disponible pour la taille choisie.`);
    }

    const sizeRule = selectedSize && group.rulesBySize
      ? Object.entries(group.rulesBySize).find(([size]) => sizeMatches(size, selectedSize))?.[1]
      : undefined;
    const min = sizeRule?.min ?? group.min;
    const max = sizeRule?.max ?? group.max;
    if (selectedOptions.length < min) {
      return errorResult('REQUIRED_OPTIONS_MISSING', `Le choix « ${group.name} » est obligatoire pour ${selectedSize ?? 'ce produit'}.`);
    }
    if (selectedOptions.length > max) {
      return errorResult('TOO_MANY_OPTIONS', `Trop d’options ont été sélectionnées pour « ${group.name} ».`);
    }
    for (const option of selectedOptions) {
      if (!option) continue;
      labels.push(`${group.name}: ${option.name}`);
      const sizePrice = selectedSize && option.priceDeltaBySize
        ? Object.entries(option.priceDeltaBySize).find(([size]) => sizeMatches(size, selectedSize))?.[1]
        : undefined;
      priceDelta += sizePrice ?? option.priceDelta;
    }
  }

  const unknownGroups = provided.filter(selection => !groups.some(group => group.name.toLowerCase() === selection.group.toLowerCase()));
  if (unknownGroups.length > 0) {
    return errorResult('INVALID_OPTIONS', `Le groupe d’options « ${unknownGroups[0].group} » n’existe pas pour ce produit.`);
  }

  return { success: true, data: { labels, priceDelta } };
}

export function applyUpdateOrder(
  restaurantId: string,
  argumentsValue: UpdateOrderArguments,
  catalog: CatalogProduct[],
): ToolResult<BasketSnapshot> {
  const items: BasketItem[] = [];

  for (const requested of argumentsValue.items) {
    const product = catalog.find(entry => entry.productId === requested.product_id);
    if (!product) return errorResult('PRODUCT_NOT_FOUND', 'Le produit demandé n’existe pas dans le catalogue officiel.');
    if (!product.available) return errorResult('PRODUCT_UNAVAILABLE', 'Le produit demandé est actuellement indisponible. Propose une alternative au client.');

    const selections = resolveSelections(product, requested.selections);
    if (!selections.success) return selections;

    items.push({
      id: `${requested.product_id}-${items.length + 1}`,
      productId: product.productId,
      name: product.name,
      detail: product.detail,
      price: product.price + selections.data.priceDelta,
      quantity: requested.quantity,
      customizations: selections.data.labels,
    });
  }

  return {
    success: true,
    data: {
      restaurantId,
      items,
      total: items.reduce((total, item) => total + item.price * item.quantity, 0),
      status: argumentsValue.status,
    },
  };
}

export function jsonToolOutput(result: ToolResult<unknown>): string {
  try {
    return JSON.stringify(result);
  } catch {
    return JSON.stringify(errorResult('SERIALIZATION_ERROR', 'Le résultat de l’opération n’a pas pu être sérialisé.', true));
  }
}

export type AddItemArguments = {
  product_id: string;
  quantity: number;
  selections?: OrderSelection[];
};

export type RemoveItemArguments = {
  product_id: string;
  quantity?: number;
};

export type SetItemQuantityArguments = {
  product_id: string;
  quantity: number;
};

export function parseAddItemArguments(rawArguments: string): ToolResult<AddItemArguments> {
  let value: unknown;
  try {
    value = JSON.parse(rawArguments);
  } catch {
    return errorResult('INVALID_JSON', 'Les arguments d’ajout ne sont pas un JSON valide. Demande au client de préciser sa commande.');
  }

  if (!isRecord(value) || typeof value.product_id !== 'string' || !value.product_id.trim()) {
    return errorResult('INVALID_ARGUMENTS', 'L’identifiant produit est manquant.');
  }

  const quantity = Number(value.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
    return errorResult('INVALID_QUANTITY', 'La quantité doit être un nombre entier compris entre 1 et 20.');
  }

  const selections = parseSelections(value.selections);
  if (!selections.success) return selections;

  return {
    success: true,
    data: {
      product_id: value.product_id.trim(),
      quantity,
      ...(selections.data.length > 0 ? { selections: selections.data } : {}),
    },
  };
}

export function parseRemoveItemArguments(rawArguments: string): ToolResult<RemoveItemArguments> {
  let value: unknown;
  try {
    value = JSON.parse(rawArguments);
  } catch {
    return errorResult('INVALID_JSON', 'Les arguments de retrait ne sont pas un JSON valide.');
  }

  if (!isRecord(value) || typeof value.product_id !== 'string' || !value.product_id.trim()) {
    return errorResult('INVALID_ARGUMENTS', 'L’identifiant produit est manquant.');
  }

  let quantity: number | undefined;
  if (value.quantity !== undefined) {
    quantity = Number(value.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      return errorResult('INVALID_QUANTITY', 'La quantité à retirer doit être comprise entre 1 et 20.');
    }
  }

  return {
    success: true,
    data: {
      product_id: value.product_id.trim(),
      ...(quantity !== undefined ? { quantity } : {}),
    },
  };
}

export function parseSetItemQuantityArguments(rawArguments: string): ToolResult<SetItemQuantityArguments> {
  let value: unknown;
  try {
    value = JSON.parse(rawArguments);
  } catch {
    return errorResult('INVALID_JSON', 'Les arguments de modification de quantité ne sont pas un JSON valide.');
  }

  if (!isRecord(value) || typeof value.product_id !== 'string' || !value.product_id.trim()) {
    return errorResult('INVALID_ARGUMENTS', 'L’identifiant produit est manquant.');
  }

  const quantity = Number(value.quantity);
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 20) {
    return errorResult('INVALID_QUANTITY', 'La quantité doit être comprise entre 0 et 20.');
  }

  return {
    success: true,
    data: {
      product_id: value.product_id.trim(),
      quantity,
    },
  };
}

function parseSelections(raw: unknown): ToolResult<OrderSelection[]> {
  if (raw === undefined) return { success: true, data: [] };
  if (!Array.isArray(raw)) return errorResult('INVALID_ARGUMENTS', 'Les options du produit sont invalides.');

  const selections: OrderSelection[] = [];
  for (const rawSelection of raw) {
    if (!isRecord(rawSelection) || typeof rawSelection.group !== 'string' || !rawSelection.group.trim() || !Array.isArray(rawSelection.options) || rawSelection.options.some(option => typeof option !== 'string')) {
      return errorResult('INVALID_ARGUMENTS', 'Un groupe d’options est invalide.');
    }
    selections.push({
      group: rawSelection.group.trim(),
      options: rawSelection.options.map(option => option.trim()).filter(Boolean),
    });
  }

  return { success: true, data: selections };
}

export function createIdempotencyKey(conversationId: string, callId: string): string {
  return `${conversationId}:${callId}`;
}

export function buildRealtimeToolDefinitions(productIds: string[] = []) {
  const productIdSchema = productIds.length > 0
    ? { type: 'string' as const, enum: productIds }
    : { type: 'string' as const };

  return [
    {
      type: 'function',
      name: 'add_item',
      description: 'Ajoute un produit au panier après avoir confirmé les choix requis. Pour un menu, demande d’abord la taille, puis chaque choix obligatoire disponible pour cette taille, et transmets toutes les sélections avec leur groupe exact.',
      parameters: {
        type: 'object',
        properties: {
          product_id: productIdSchema,
          quantity: { type: 'integer', minimum: 1, maximum: 20 },
          selections: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                group: { type: 'string' },
                options: { type: 'array', items: { type: 'string' } },
              },
              required: ['group', 'options'],
              additionalProperties: false,
            },
          },
        },
        required: ['product_id', 'quantity'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'remove_item',
      description: 'Retire un produit du panier. Si quantity est omis, retire toute la ligne.',
      parameters: {
        type: 'object',
        properties: {
          product_id: productIdSchema,
          quantity: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['product_id'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'update_item_quantity',
      description: 'Change la quantité exacte d’un produit déjà dans le panier. Mettre 0 pour le retirer complètement.',
      parameters: {
        type: 'object',
        properties: {
          product_id: productIdSchema,
          quantity: { type: 'integer', minimum: 0, maximum: 20 },
        },
        required: ['product_id', 'quantity'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'update_order',
      description: 'Remplace le panier entier par un nouvel état complet. À n’utiliser que si l’état du panier est incertain après une correction complexe.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                product_id: productIdSchema,
                quantity: { type: 'integer', minimum: 1, maximum: 20 },
                selections: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      group: { type: 'string' },
                      options: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['group', 'options'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['product_id', 'quantity'],
              additionalProperties: false,
            },
          },
          status: { type: 'string', enum: ['editing', 'ready_to_confirm', 'confirmed'] },
        },
        required: ['items', 'status'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'get_basket',
      description: 'Récupère le panier officiel pour faire un récapitulatif ou vérifier l’état.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      type: 'function',
      name: 'submit_order',
      description: 'Transmet au restaurant une commande explicitement confirmée par le client. À appeler UNIQUEMENT après un récapitulatif et une confirmation claire ("oui", "je confirme").',
      parameters: {
        type: 'object',
        properties: { confirmation: { type: 'string', enum: ['explicit'] } },
        required: ['confirmation'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'request_human',
      description: 'Demande un transfert humain lorsque la récupération automatique échoue.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', minLength: 1, maxLength: 240 } },
        required: ['reason'],
        additionalProperties: false,
      },
    },
  ];
}