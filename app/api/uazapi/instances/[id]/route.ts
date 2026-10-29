import { NextResponse } from "next/server";
import { getSupabaseSession } from "@/lib/supabase/session";
import { requireTenantId } from "@/lib/tenant";

function providerBody(text: string) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

function providerDetail(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function normalizeInstanceList(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.instances)) return value.instances;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function sameProviderInstance(item: any, record: { external_id?: string | null; name?: string | null }, accountId: string) {
  const itemId = String(item?.id ?? item?.instance?.id ?? "");
  const itemName = String(item?.name ?? item?.instance?.name ?? "");
  const adminField02 = String(item?.adminField02 ?? item?.instance?.adminField02 ?? "");

  if (record.external_id && itemId && itemId === String(record.external_id)) return true;
  if (record.name && itemName === String(record.name) && (!adminField02 || adminField02 === accountId)) return true;
  return false;
}

async function deleteAtProvider(baseUrl: string, token: string) {
  const response = await fetch(baseUrl + "/instance", {
    method: "DELETE",
    headers: { Accept: "application/json", token },
    cache: "no-store",
  });

  const text = await response.text();
  return {
    ok: response.ok || response.status === 202 || response.status === 404,
    status: response.status,
    body: providerBody(text),
  };
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  try {
    const accountId = requireTenantId();
    const supabase = getSupabaseSession();

    const { data: record, error } = await supabase
      .from("instances")
      .select("id,name,external_id,base_url,api_token")
      .eq("id", params.id)
      .eq("account_id", accountId)
      .single();

    if (error || !record) {
      return NextResponse.json({ ok: false, error: "Instância não encontrada." }, { status: 404 });
    }

    let providerState: "deleted" | "already_missing" | "local_only" = "local_only";

    if (record.base_url && record.api_token) {
      const baseUrl = String(record.base_url).replace(/\/$/, "");
      let providerDelete = await deleteAtProvider(baseUrl, record.api_token);

      if (providerDelete.status === 401) {
        const adminToken = process.env.UAZAPI_ADMIN_TOKEN;

        if (!adminToken) {
          return NextResponse.json(
            {
              ok: false,
              error: "O token da instância não é mais válido e UAZAPI_ADMIN_TOKEN não está configurado para reconciliar a exclusão.",
            },
            { status: 502 },
          );
        }

        const listResponse = await fetch(baseUrl + "/instance/all", {
          method: "GET",
          headers: { Accept: "application/json", admintoken: adminToken },
          cache: "no-store",
        });

        const listText = await listResponse.text();
        const listBody = providerBody(listText);

        if (!listResponse.ok) {
          return NextResponse.json(
            {
              ok: false,
              error:
                "O token antigo da instância é inválido e não foi possível consultar a lista administrativa da UAZAPI (" +
                listResponse.status +
                "): " +
                providerDetail(listBody),
            },
            { status: 502 },
          );
        }

        const current = normalizeInstanceList(listBody).find((item) =>
          sameProviderInstance(item, record, accountId),
        );

        if (!current) {
          // A instância já foi removida da UAZAPI. O registro local ficou órfão.
          providerState = "already_missing";
        } else {
          const currentToken = String(
            current?.token ??
            current?.instance?.token ??
            current?.apikey ??
            current?.instance?.apikey ??
            "",
          );

          if (!currentToken) {
            return NextResponse.json(
              {
                ok: false,
                error: "A instância ainda existe na UAZAPI, mas a listagem administrativa não retornou um token atual para excluí-la.",
              },
              { status: 502 },
            );
          }

          providerDelete = await deleteAtProvider(baseUrl, currentToken);

          if (!providerDelete.ok) {
            return NextResponse.json(
              {
                ok: false,
                error:
                  "A UAZAPI não conseguiu excluir a instância após atualizar o token (" +
                  providerDelete.status +
                  "): " +
                  providerDetail(providerDelete.body),
              },
              { status: 502 },
            );
          }

          providerState = providerDelete.status === 404 ? "already_missing" : "deleted";
        }
      } else if (!providerDelete.ok) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "A UAZAPI não conseguiu excluir a instância (" +
              providerDelete.status +
              "): " +
              providerDetail(providerDelete.body),
          },
          { status: 502 },
        );
      } else {
        providerState = providerDelete.status === 404 ? "already_missing" : "deleted";
      }
    }

    const { error: deleteError } = await supabase
      .from("instances")
      .delete()
      .eq("id", record.id)
      .eq("account_id", accountId);

    if (deleteError) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "A instância foi reconciliada na UAZAPI, mas não foi possível remover o registro local: " +
            deleteError.message,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      deletedId: record.id,
      providerState,
      message:
        providerState === "already_missing"
          ? "A instância já não existia na UAZAPI; o registro antigo foi removido do UaiDisparos."
          : "Instância excluída com sucesso.",
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Erro ao excluir instância." },
      { status: 500 },
    );
  }
}
