export function SavedDeliveryDescription({ description }: { description?: string }) {
  const plainText = description?.trim();
  if (!plainText) return null;
  return (
    <aside className="saved-delivery-description" aria-label="Delivery description">
      <strong>Delivery description</strong>
      <p>{plainText}</p>
    </aside>
  );
}
