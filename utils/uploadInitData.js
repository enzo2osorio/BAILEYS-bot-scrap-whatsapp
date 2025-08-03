const supabase = require('../supabase');
const similarDestinatarios2 = require('../sd2');

async function uploadCategoryDataMassive(entries) {
    try {

        if(!entries){
            console.log("no existen categorias");
            throw new Error("No categories provided");
        }

        for (const entry of entries) {

            const {categoria} = entry;

            const {data: existingCategoria, error: checkError} = await supabase
                .from('categorias')
                .select('id')
                .eq('name', categoria)
                .single();

            if (existingCategoria) {
                console.log(`Categoria already exists: ${categoria}`);
                continue;
            }

            if (checkError && checkError.code !== 'PGRST116') {
                console.error(`Error checking categoria ${categoria}:`, checkError);
                continue;
            }

            const {data, error} = await supabase
                .from('categorias')
                .insert({name: categoria});

            if (error) {
                console.error(`Error inserting categoria ${categoria}:`, error);
                throw error;
            }
            console.log(`Inserted categoria: ${categoria}`);
        }

    } catch (error) {
        console.error('Error uploading initial data:', error);
    }

}



async function uploadSubcategoryData(entries) {
    try {
        if(!entries){
            console.log("no existen entradas")
            throw error;
        }
        for (const entry of entries) {
            
            const {categoria, subcategoria} = entry;

            const {data: existingCategoria, error: checkError} = await supabase
                .from('categorias')
                .select('id')
                .eq('name', categoria)
                .single();

            if (existingCategoria) {
                console.log(`Categoria already exists: ${categoria}`);
                continue;
            }

            if (checkError && checkError.code !== 'PGRST116') {
                console.error(`Error checking categoria ${categoria}:`, checkError);
                continue;
            }

            const {data: existingSubcategoria, error: subcatCheckError} = await supabase
                .from('subcategorias')
                .select('id')
                .eq('name', subcategoria)
                .single();

            if (existingSubcategoria) {
                console.log(`Subcategoria already exists: ${subcategoria}`);
                continue;
            }

            if (subcatCheckError && subcatCheckError.code !== 'PGRST116') {
                console.error(`Error checking subcategoria ${subcategoria}:`, subcatCheckError);
                continue;
            }

            const {data, error} = await supabase
                .from('subcategorias')
                .insert({name: subcategoria, categoria_id: existingCategoria.id});

            if (error) {
                console.error(`Error inserting subcategoria ${subcategoria}:`, error);
                throw error;
            }
            console.log(`Inserted subcategoria: ${subcategoria}`);
        }

    } catch (error) {
        console.error('Error uploading initial data:', error);
    }

}



async function uploadSubcategoryData(entries) {
    try {
        if(!entries){
            console.log("no existen entradas")
            throw error;
        }
        for (const entry of entries) {
            const {categoria, subcategoria} = entry;

            const {data: categoriaByName , error: categoriaError} = await supabase
                .from('categorias')
                .select('id')
                .eq('name', categoria)
                .single();

            if (!categoriaByName || !categoriaByName.id) {
                console.error(`Categoria not found: ${categoria}`);
                continue;
            }

            const { data: existingSubcategoria, error: checkError } = await supabase
                .from('subcategorias')
                .select('id')
                .eq('name', subcategoria)
                .single();

            if (existingSubcategoria) {
                console.log(`Subcategoria already exists: ${subcategoria}`);
                continue;
            }

            if (checkError && checkError.code !== 'PGRST116') {
                console.error(`Error checking subcategoria ${subcategoria}:`, checkError);
                continue;
            }

            const {data, error} = await supabase
                .from('subcategorias')
                .insert({
                    name: subcategoria,
                    categoria_id: categoriaByName.id,
                    
                });

            if (error) {
                console.error(`Error inserting subcategoria ${subcategoria}:`, error);
                throw error;
            }
            console.log(`Inserted subcategoria: ${subcategoria}`);
        }

    } catch (error) {
        console.error('Error uploading initial data:', error);
    }
}


async function uploadDestinatariosData(entries) {
    try {
        if (!entries) {
            console.log("No existen entradas");
            throw new Error("No entries provided");
        }
        for (const entry of entries) {
            const {categoria, subcategoria, nombreCanonical} = entry;

            const {data: categoriaByName , error: categoriaError} = await supabase
                .from('categorias')
                .select('id')
                .eq('name', categoria)
                .single();

            if (!categoriaByName || !categoriaByName.id) {
                console.error(`Categoria not found: ${categoria}`);
                continue;
            }

            const {data: subcategoriaByName , error: subcategoriaError} = await supabase
                .from('subcategorias')
                .select('id')
                .eq('name', subcategoria)
                .single();

            if (!subcategoriaByName || !subcategoriaByName.id) {
                console.error(`Subcategoria not found: ${subcategoria}`);
                continue;
            }

            const {data: existingDestinatario, error: checkError} = await supabase
                .from('destinatarios')
                .select('id')
                .eq('name', nombreCanonical)
                .single();

            if (existingDestinatario) {
                console.log(`Destinatario already exists: ${nombreCanonical}`);
                continue;
            }

            const {data, error} = await supabase
                .from('destinatarios')
                .insert({
                    name: nombreCanonical,
                    category_id: categoriaByName.id,
                    subcategory_id: subcategoriaByName.id,
                });

            if (error) {
                console.error(`Error inserting destinatario ${nombreCanonical}:`, error);
                throw error;
            }
            console.log(`Inserted destinatario: ${nombreCanonical}`);
        }

    } catch (error) {
        console.error('Error uploading initial data:', error);
    }

}

async function uploadAliasesForDestinatarios(entries) {
    try {
        if (!entries) {
            console.log("No existen entradas");
            throw new Error("No entries provided");
        }

        for (const entry of entries) {
            const {nombreCanonical, nombresRelacionados} = entry;

            const {data: destinatarioByName , error: destinatarioError} = await supabase
                .from('destinatarios')
                .select('id')
                .eq('name', nombreCanonical)
                .single();

            if (!destinatarioByName || !destinatarioByName.id) {
                console.error(`Destinatario not found: ${nombreCanonical}`);
                continue;
            }

            for (const alias of nombresRelacionados) {

                const { data: existingAlias, error: aliasCheckError } = await supabase
                .from('destinatario_aliases')
                .select('id')
                .eq('alias', alias)
                .maybeSingle();

                if (existingAlias) {
                console.log(`Alias ya existe: ${alias}, se omite.`);
                continue;
                }
                
                if (aliasCheckError) {
                    console.error(`Error checking alias ${alias}:`, aliasCheckError);
                    continue;
                }

                const {data, error} = await supabase
                    .from('destinatario_aliases')
                    .insert({
                        alias: alias,
                        destinatario_id: destinatarioByName.id,
                });

            if (error) {
                console.error(`Error inserting alias ${alias}:`, error);
                throw error;
            }
            console.log(`Inserted alias: ${alias} para destinatario: ${nombreCanonical}`);
            }
        }

    } catch (error) {
        console.error('Error uploading initial data:', error);
    }

}


uploadAliasesForDestinatarios(similarDestinatarios2);