import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase/server';
import {
  fetchMenuConfigurations,
  upsertMenuConfiguration,
  deleteMenuConfiguration,
  type MenuConfigItem,
} from '@/lib/supabase/menu-config';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const brandId = searchParams.get('brandId');

  if (!brandId) {
    return NextResponse.json({ error: 'brandId requis' }, { status: 400 });
  }

  try {
    const configurations = await fetchMenuConfigurations(brandId);
    return NextResponse.json({ configurations });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Erreur serveur' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { brandId, sizeName, sides, sauces, drinks } = body as {
      brandId: string;
      sizeName: string;
      sides: MenuConfigItem[];
      sauces: MenuConfigItem[];
      drinks: MenuConfigItem[];
    };

    if (!brandId || !sizeName) {
      return NextResponse.json({ error: 'brandId et sizeName requis' }, { status: 400 });
    }

    const result = await upsertMenuConfiguration(brandId, sizeName, sides || [], sauces || [], drinks || []);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Erreur serveur' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const brandId = searchParams.get('brandId');
  const sizeName = searchParams.get('sizeName');

  if (!brandId || !sizeName) {
    return NextResponse.json({ error: 'brandId et sizeName requis' }, { status: 400 });
  }

  try {
    const result = await deleteMenuConfiguration(brandId, sizeName);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Erreur serveur' },
      { status: 500 }
    );
  }
}
