import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ThemeToggle } from '@/features/theme/ThemeToggle';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

interface AuthLayoutProps {
  title: string;
  description: string;
  footer: { text: string; linkLabel: string; to: string };
  children: ReactNode;
}

/** The centered card around the login and register forms. */
export function AuthLayout({ title, description, footer, children }: AuthLayoutProps) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center gap-6 bg-muted/40 p-6">
      <div className="absolute top-3 right-3">
        <ThemeToggle />
      </div>
      <p className="text-xl font-semibold tracking-tight">Document Chat</p>
      <Card className="w-full max-w-sm">
        <CardHeader>
          {/* CardTitle renders a div, so the page heading is an explicit h1 for assistive technology. */}
          <CardTitle>
            <h1>{title}</h1>
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
        <CardFooter className="justify-center text-sm text-muted-foreground">
          {footer.text}&nbsp;
          <Link to={footer.to} className="font-medium text-foreground underline underline-offset-4">
            {footer.linkLabel}
          </Link>
        </CardFooter>
      </Card>
    </div>
  );
}
