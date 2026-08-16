export function SavedDeliveryDescription({ description, label = "Delivery description" }: { description?: string; label?: string }) {
  const plainText = description?.trim();
  if (!plainText) return null;
  return (
    <aside className="saved-delivery-description" aria-label={label}>
      <strong>{label}</strong>
      <p>{plainText}</p>
    </aside>
  );
}
