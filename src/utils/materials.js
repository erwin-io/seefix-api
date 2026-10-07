import { ApiError } from "../errors.js";

function optionalText(value, maxLength, field) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > maxLength)
    throw new ApiError(
      400,
      `${field} must not exceed ${maxLength} characters.`,
      "VALIDATION_ERROR",
    );
  return text;
}

function optionalQuantity(value, field = "quantity") {
  if (value == null || value === "") return null;
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity < 0)
    throw new ApiError(
      400,
      `${field} must be a non-negative number.`,
      "VALIDATION_ERROR",
    );
  return quantity;
}

function optionalUuid(value, field) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text))
    throw new ApiError(400, `${field} must be a valid UUID.`, "VALIDATION_ERROR");
  return text;
}

export function normalizeMaterialItem(item, indexLabel = "material") {
  if (!item || typeof item !== "object" || Array.isArray(item))
    throw new ApiError(400, `${indexLabel} must be an object.`, "VALIDATION_ERROR");

  const materialName = optionalText(item.materialName, 200, `${indexLabel}.materialName`);
  if (!materialName)
    throw new ApiError(400, `${indexLabel}.materialName is required.`, "VALIDATION_ERROR");

  return {
    materialId: optionalUuid(item.materialId, `${indexLabel}.materialId`),
    materialName,
    unit: optionalText(item.unit, 50, `${indexLabel}.unit`),
    quantity: optionalQuantity(item.quantity, `${indexLabel}.quantity`),
    notes: optionalText(item.notes, 4000, `${indexLabel}.notes`),
  };
}

export function parseActualMaterials(value) {
  if (value == null || value === "") return [];

  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ApiError(
        400,
        "actualMaterials must be a JSON array.",
        "VALIDATION_ERROR",
      );
    }
  }

  if (!Array.isArray(parsed))
    throw new ApiError(
      400,
      "actualMaterials must be a JSON array.",
      "VALIDATION_ERROR",
    );
  if (parsed.length > 50)
    throw new ApiError(
      400,
      "actualMaterials cannot contain more than 50 items.",
      "VALIDATION_ERROR",
    );

  return parsed.map((item, index) =>
    normalizeMaterialItem(item, `actualMaterials[${index}]`),
  );
}
