import { BackofficeStoreDetailPage } from "@/components/backoffice-store-detail-page";

type StoreDetailRouteProps = {
  params: Promise<{ storeId: string }>;
};

export default async function BackofficeStoreDetailRoute({ params }: StoreDetailRouteProps) {
  const { storeId } = await params;
  return <BackofficeStoreDetailPage storeId={storeId} />;
}
