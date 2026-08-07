import { ImageResponse } from "next/og";

export const size = {
  width: 512,
  height: 512,
};

export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #f97316 0%, #fb923c 45%, #0f172a 100%)",
          color: "white",
          fontSize: 170,
          fontWeight: 800,
          borderRadius: 110,
        }}
      >
        POS
      </div>
    ),
    size,
  );
}
