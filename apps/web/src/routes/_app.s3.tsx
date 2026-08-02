import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/s3')({
  component: S3Layout,
});

function S3Layout() {
  return <Outlet />;
}
