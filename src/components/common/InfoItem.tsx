export function InfoItem({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={`info-item ${wide ? "wide" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
